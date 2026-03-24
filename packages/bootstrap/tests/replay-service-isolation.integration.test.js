import { describe, test, expect, vi, beforeAll, afterAll } from 'vitest';
import { MongoDBContainer } from '@testcontainers/mongodb';
import { MongoClient } from 'mongodb';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debugBare: vi.fn(),
  }),
  getStream: vi.fn().mockReturnValue({ write: vi.fn() }),
}));

const mqemitter = (await import('mqemitter')).default;
const { registerSharedMqEmitter } = await import('@lazyapps/mqemitter');
const { inmemory: aggregateStoreInmemory } =
  await import('@lazyapps/aggregatestore-inmemory');
const { mongodb: eventStoreMongo } =
  await import('@lazyapps/eventstore-mongodb');
const { mongodb: readModelStorageMongo } =
  await import('@lazyapps/readmodelstorage-mongodb');
const { startCommandProcessor } = await import('@lazyapps/command-processor');
const {
  commandProcessorEventBusMqEmitter,
  readModelEventBusMqEmitter,
  readModelListenerMqEmitter,
  commandSenderMqEmitter,
} = await import('@lazyapps/mqemitter');
const { express: expressReceiver } =
  await import('@lazyapps/express/command-receiver/index.js');
const { initializeContext: initializeRmContext } =
  await import('@lazyapps/readmodels/context.js');

// Two aggregates: customer and order
const testAggregates = {
  customer: {
    initial: () => ({}),
    commands: {
      CREATE_CUSTOMER: (aggregate, payload) => {
        if (aggregate.created)
          throw Object.assign(new Error('Already exists'), {
            name: 'ValidationError',
          });
        return { type: 'CUSTOMER_CREATED', payload };
      },
    },
    projections: {
      CUSTOMER_CREATED: (aggregate, event) => ({
        ...aggregate,
        created: true,
        ...event.payload,
      }),
    },
  },
  order: {
    initial: () => ({}),
    commands: {
      CREATE_ORDER: (aggregate, payload) => {
        if (aggregate.created)
          throw Object.assign(new Error('Already exists'), {
            name: 'ValidationError',
          });
        return { type: 'ORDER_CREATED', payload };
      },
    },
    projections: {
      ORDER_CREATED: (aggregate, event) => ({
        ...aggregate,
        created: true,
        ...event.payload,
      }),
    },
  },
};

// Both services have a read model named "overview" — this is the bug scenario
const ordersReadModels = {
  overview: {
    projections: {
      ORDER_CREATED: ({ storage }, event) =>
        storage.insertOne('orders_overview', {
          id: event.aggregateId,
          product: event.payload.product,
        }),
    },
    resolvers: {
      all: (storage) =>
        storage.find('orders_overview', {}).project({ _id: 0 }).toArray(),
    },
    collections: ['orders_overview'],
    replayRelevantEvents: ['ORDER_CREATED'],
  },
};

const customersReadModels = {
  overview: {
    projections: {
      CUSTOMER_CREATED: ({ storage }, event) =>
        storage.insertOne('customers_overview', {
          id: event.aggregateId,
          name: event.payload.name,
        }),
    },
    resolvers: {
      all: (storage) =>
        storage.find('customers_overview', {}).project({ _id: 0 }).toArray(),
    },
    collections: ['customers_overview'],
    replayRelevantEvents: ['CUSTOMER_CREATED'],
  },
};

const createInlineAdminInstructionHandler = (context) => {
  return (correlationId, instruction) => {
    const lm = context.lifecycleManager;
    if (!lm) return;
    switch (instruction.type) {
      case 'activate':
        if (instruction.targetReadModel) {
          lm.activate(instruction.targetReadModel, correlationId).catch(
            () => {},
          );
        }
        break;
      case 'stop':
        if (instruction.targetReadModel) {
          lm.stop(instruction.targetReadModel, correlationId);
        }
        break;
      case 'catchupDone': {
        if (instruction.targetReadModel) {
          const toTimestamp = instruction.toTimestamp || 0;
          lm.catchupDone(
            instruction.targetReadModel,
            toTimestamp,
            correlationId,
          ).catch(() => {});
        }
        break;
      }
      case 'startReplay':
        if (instruction.targetReadModel) {
          lm.startReplay(instruction.targetReadModel, correlationId).catch(
            () => {},
          );
        }
        break;
      case 'replayDone':
        if (instruction.targetReadModel) {
          lm.replayDone(instruction.targetReadModel, correlationId).catch(
            () => {},
          );
        }
        break;
      case 'reset':
        if (instruction.targetReadModel) {
          const rm = context.readModels[instruction.targetReadModel];
          const cols = rm.collections || [instruction.targetReadModel];
          cols.forEach((col) => {
            context.storage
              .perRequest(correlationId)
              .dropCollection(col)
              .catch(() => {});
          });
        }
        break;
    }
  };
};

const waitForCondition = (fn, timeout = 5000, interval = 100) => {
  const start = Date.now();
  const poll = () =>
    Promise.resolve()
      .then(fn)
      .then((result) => {
        if (result) return;
        if (Date.now() - start > timeout)
          throw new Error('Timeout waiting for condition');
        return new Promise((r) => setTimeout(r, interval)).then(poll);
      });
  return poll();
};

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

describe('replay service isolation integration', { timeout: 30000 }, () => {
  let container;
  let connectionString;
  let cleanupClient;
  let commandServer;
  let commandPort;
  let ordersContext;
  let customersContext;
  let cpEventBusInstance;
  let suppressErrors = false;

  const errorHandler = (err) => {
    if (suppressErrors) return;
    throw err;
  };

  const rejectionHandler = (reason) => {
    if (suppressErrors) return;
    throw reason;
  };

  beforeAll(() => {
    process.on('uncaughtException', errorHandler);
    process.on('unhandledRejection', rejectionHandler);

    // Register shared mqemitters for this test
    registerSharedMqEmitter('iso-commands', mqemitter());
    registerSharedMqEmitter('iso-events', mqemitter());
    registerSharedMqEmitter('iso-queries-orders', mqemitter());
    registerSharedMqEmitter('iso-queries-customers', mqemitter());

    return new MongoDBContainer('mongo:7')
      .start()
      .then((c) => {
        container = c;
        connectionString =
          container.getConnectionString() + '?directConnection=true';
        return MongoClient.connect(connectionString);
      })
      .then((client) => {
        cleanupClient = client;

        // Start command processor (has replay/catchup handlers)
        return startCommandProcessor(
          { serviceId: 'ISO-CMD' },
          {
            receiver: expressReceiver({
              port: 0,
              credentialsRequired: false,
            }),
            aggregateStore: aggregateStoreInmemory(),
            eventStore: eventStoreMongo({
              url: connectionString,
              database: 'iso-events',
            }),
            eventBus: commandProcessorEventBusMqEmitter({
              mqName: 'iso-events',
            }),
            aggregates: testAggregates,
          },
        );
      })
      .then((server) => {
        commandServer = server;
        commandPort = server.address().port;

        // Initialize orders RM with lifecycle
        return initializeRmContext(
          { serviceId: 'ISO-ORDERS' },
          {
            readModels: ordersReadModels,
            endpointName: 'ISO-ORDERS',
            storage: readModelStorageMongo({
              url: connectionString,
              database: 'iso-readmodels',
            }),
            eventBus: readModelEventBusMqEmitter({ mqName: 'iso-events' }),
            changeNotificationSender: {
              sendChangeNotification: () => () => Promise.resolve(),
            },
            commandSender: commandSenderMqEmitter({
              mqName: 'iso-commands',
            }),
            lifecycle: true,
          },
        );
      })
      .then((context) => {
        ordersContext = context;
        context.adminInstructionHandler =
          createInlineAdminInstructionHandler(context);

        // Initialize customers RM with lifecycle
        return initializeRmContext(
          { serviceId: 'ISO-CUSTOMERS' },
          {
            readModels: customersReadModels,
            endpointName: 'ISO-CUSTOMERS',
            storage: readModelStorageMongo({
              url: connectionString,
              database: 'iso-readmodels',
            }),
            eventBus: readModelEventBusMqEmitter({ mqName: 'iso-events' }),
            changeNotificationSender: {
              sendChangeNotification: () => () => Promise.resolve(),
            },
            commandSender: commandSenderMqEmitter({
              mqName: 'iso-commands',
            }),
            lifecycle: true,
          },
        );
      })
      .then((context) => {
        customersContext = context;
        context.adminInstructionHandler =
          createInlineAdminInstructionHandler(context);

        // Get a message bus instance for publishing admin instructions
        return commandProcessorEventBusMqEmitter({
          mqName: 'iso-events',
        })();
      })
      .then((eventBus) => {
        cpEventBusInstance = eventBus;
      });
  });

  afterAll(() => {
    suppressErrors = true;
    return Promise.resolve()
      .then(() =>
        commandServer
          ? new Promise((resolve) => commandServer.close(resolve))
          : undefined,
      )
      .then(() => (cleanupClient ? cleanupClient.close() : undefined))
      .then(() => (container ? container.stop() : undefined));
  });

  const sendCommand = (aggregateName, command, aggregateId, payload) =>
    fetch(`http://127.0.0.1:${commandPort}/api/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command,
        aggregateName,
        aggregateId,
        payload,
      }),
    });

  const publishAdmin = (instruction) =>
    cpEventBusInstance.publishAdminInstruction('test-corr')({
      ...instruction,
      correlationId: 'test-corr',
    });

  const getCollection = (name) =>
    cleanupClient
      .db('iso-readmodels')
      .collection(name)
      .find({}, { projection: { _id: 0 } })
      .sort({ id: 1 })
      .toArray();

  const activateRm = (context, rmName) =>
    context.lifecycleManager.activate(rmName, 'test-corr').then(() =>
      // With empty event store, catchup completes instantly via CP.
      // Wait for CP to send catchupDone via admin instruction, then transition to live.
      waitForCondition(() =>
        Promise.resolve(context.lifecycleManager.getState(rmName)).then(
          (state) => state === 'catchup',
        ),
      ).then(() =>
        // CP sends catchupDone via admin instruction
        publishAdmin({
          type: 'catchupDone',
          targetEndpointName: context.endpointName,
          targetReadModel: rmName,
          toTimestamp: 0,
        }),
      ),
    );

  test('replaying overview for orders does not duplicate customers', () =>
    // Step 1: Activate both RM services
    activateRm(ordersContext, 'overview')
      .then(() =>
        waitForCondition(() =>
          Promise.resolve(
            ordersContext.lifecycleManager.getState('overview'),
          ).then((s) => s === 'live'),
        ),
      )
      .then(() => activateRm(customersContext, 'overview'))
      .then(() =>
        waitForCondition(() =>
          Promise.resolve(
            customersContext.lifecycleManager.getState('overview'),
          ).then((s) => s === 'live'),
        ),
      )
      .then(() => {
        // Step 2: Create customers and orders
        return sendCommand('customer', 'CREATE_CUSTOMER', 'cust-1', {
          name: 'Alice',
        });
      })
      .then((res) => {
        expect(res.status).toBe(200);
        return sendCommand('customer', 'CREATE_CUSTOMER', 'cust-2', {
          name: 'Bob',
        });
      })
      .then((res) => {
        expect(res.status).toBe(200);
        return sendCommand('order', 'CREATE_ORDER', 'ord-1', {
          product: 'Widget',
        });
      })
      .then((res) => {
        expect(res.status).toBe(200);
        return sendCommand('order', 'CREATE_ORDER', 'ord-2', {
          product: 'Gadget',
        });
      })
      .then((res) => {
        expect(res.status).toBe(200);

        // Step 3: Wait for both read models to be projected
        return waitForCondition(() =>
          Promise.all([
            getCollection('customers_overview'),
            getCollection('orders_overview'),
          ]).then(
            ([customers, orders]) =>
              customers.length === 2 && orders.length === 2,
          ),
        );
      })
      .then(() =>
        // Step 4: Verify initial state
        Promise.all([
          getCollection('customers_overview'),
          getCollection('orders_overview'),
        ]),
      )
      .then(([customers, orders]) => {
        expect(customers).toHaveLength(2);
        expect(customers).toEqual(
          expect.arrayContaining([
            { id: 'cust-1', name: 'Alice' },
            { id: 'cust-2', name: 'Bob' },
          ]),
        );
        expect(orders).toHaveLength(2);
        expect(orders).toEqual(
          expect.arrayContaining([
            { id: 'ord-1', product: 'Widget' },
            { id: 'ord-2', product: 'Gadget' },
          ]),
        );

        // Step 5: Stop orders RM
        publishAdmin({
          type: 'stop',
          targetEndpointName: 'ISO-ORDERS',
          targetReadModel: 'overview',
        });

        return waitForCondition(() =>
          Promise.resolve(
            ordersContext.lifecycleManager.getState('overview'),
          ).then((s) => s === 'stopped'),
        );
      })
      .then(() => {
        // Step 6: Clear orders collection
        return cleanupClient
          .db('iso-readmodels')
          .collection('orders_overview')
          .deleteMany({});
      })
      .then(() => {
        // Step 7: Put orders RM in replay mode
        publishAdmin({
          type: 'startReplay',
          targetEndpointName: 'ISO-ORDERS',
          targetReadModel: 'overview',
        });

        return waitForCondition(() =>
          Promise.resolve(
            ordersContext.lifecycleManager.getState('overview'),
          ).then((s) => s === 'replay'),
        );
      })
      .then(() => {
        // Step 8: Send replay command to CP WITH targetEndpointName
        publishAdmin({
          type: 'replay',
          readModel: 'overview',
          fromTimestamp: 0,
          targetEndpointName: 'ISO-ORDERS',
          replayRelevantEvents: ['ORDER_CREATED'],
        });

        // Wait for CP replay to complete (poll CP status)
        return waitForCondition(() =>
          Promise.resolve(
            commandServer.__testing__
              ? true
              : // Fallback: check if orders have been re-projected
                getCollection('orders_overview').then(
                  (orders) => orders.length === 2,
                ),
          ),
        );
      })
      .then(() =>
        // Give replay events time to be processed
        delay(1000),
      )
      .then(() => {
        // Step 9: Send replayDone to orders RM
        publishAdmin({
          type: 'replayDone',
          targetEndpointName: 'ISO-ORDERS',
          targetReadModel: 'overview',
        });

        return waitForCondition(() =>
          Promise.resolve(
            ordersContext.lifecycleManager.getState('overview'),
          ).then((s) => s === 'stopped'),
        );
      })
      .then(() => {
        // Step 10: Re-activate orders RM
        return activateRm(ordersContext, 'overview');
      })
      .then(() =>
        waitForCondition(() =>
          Promise.resolve(
            ordersContext.lifecycleManager.getState('overview'),
          ).then((s) => s === 'live'),
        ),
      )
      .then(() =>
        // Step 11: Verify customers were NOT duplicated
        Promise.all([
          getCollection('customers_overview'),
          getCollection('orders_overview'),
        ]),
      )
      .then(([customers, orders]) => {
        // CRITICAL: customers should still have exactly 2 (not 4)
        expect(customers).toHaveLength(2);
        expect(customers).toEqual(
          expect.arrayContaining([
            { id: 'cust-1', name: 'Alice' },
            { id: 'cust-2', name: 'Bob' },
          ]),
        );

        // Orders should be re-projected correctly
        expect(orders).toHaveLength(2);
        expect(orders).toEqual(
          expect.arrayContaining([
            { id: 'ord-1', product: 'Widget' },
            { id: 'ord-2', product: 'Gadget' },
          ]),
        );
      }));
});
