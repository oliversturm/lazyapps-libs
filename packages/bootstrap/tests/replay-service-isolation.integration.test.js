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
const { startReadModels } = await import('@lazyapps/readmodels');
const {
  commandProcessorEventBusMqEmitter,
  readModelEventBusMqEmitter,
  readModelListenerMqEmitter,
  commandSenderMqEmitter,
} = await import('@lazyapps/mqemitter');
const { express: expressReceiver } =
  await import('@lazyapps/express/command-receiver/index.js');
const { startAdmin } = await import('../admin.js');

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
  },
};

const waitForCondition = (fn, timeout = 10000, interval = 100) => {
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

describe('replay service isolation integration', { timeout: 120000 }, () => {
  let container;
  let connectionString;
  let cleanupClient;
  let commandServer;
  let commandPort;
  let adminServer;
  let adminPort;

  beforeAll(() => {
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

        // Start command processor
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

        // Start orders read model service
        return startReadModels(
          { serviceId: 'ISO-ORDERS' },
          {
            readModels: ordersReadModels,
            storage: readModelStorageMongo({
              url: connectionString,
              database: 'iso-readmodels',
            }),
            eventBus: readModelEventBusMqEmitter({ mqName: 'iso-events' }),
            listener: readModelListenerMqEmitter({
              mqName: 'iso-queries-orders',
            }),
            changeNotificationSender: {
              sendChangeNotification: () => () => Promise.resolve(),
            },
            commandSender: commandSenderMqEmitter({
              mqName: 'iso-commands',
            }),
          },
        );
      })
      .then(() =>
        // Start customers read model service
        startReadModels(
          { serviceId: 'ISO-CUSTOMERS' },
          {
            readModels: customersReadModels,
            storage: readModelStorageMongo({
              url: connectionString,
              database: 'iso-readmodels',
            }),
            eventBus: readModelEventBusMqEmitter({ mqName: 'iso-events' }),
            listener: readModelListenerMqEmitter({
              mqName: 'iso-queries-customers',
            }),
            changeNotificationSender: {
              sendChangeNotification: () => () => Promise.resolve(),
            },
            commandSender: commandSenderMqEmitter({
              mqName: 'iso-commands',
            }),
          },
        ),
      )
      .then(() =>
        // Start admin server (delegates via event bus, no direct
        // eventStore/readModelStorage access)
        startAdmin(
          { serviceId: 'ISO-CMD' },
          {
            port: 0,
            eventBus: commandProcessorEventBusMqEmitter({
              mqName: 'iso-events',
            }),
            readModels: ordersReadModels,
          },
        ),
      )
      .then((server) => {
        adminServer = server;
        adminPort = server.address().port;
      });
  });

  afterAll(() =>
    Promise.resolve()
      .then(() =>
        commandServer
          ? new Promise((resolve) => commandServer.close(resolve))
          : undefined,
      )
      .then(() =>
        adminServer
          ? new Promise((resolve) => adminServer.close(resolve))
          : undefined,
      )
      .then(() => (cleanupClient ? cleanupClient.close() : undefined))
      .then(() => (container ? container.stop() : undefined)),
  );

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

  const fetchAdmin = (path, options = {}) =>
    fetch(`http://127.0.0.1:${adminPort}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    }).then((res) => res.json().then((body) => ({ status: res.status, body })));

  const getCollection = (name) =>
    cleanupClient
      .db('iso-readmodels')
      .collection(name)
      .find({}, { projection: { _id: 0 } })
      .sort({ id: 1 })
      .toArray();

  test('replaying overview for orders does not duplicate customers', () =>
    // Step 1: Create customers and orders
    sendCommand('customer', 'CREATE_CUSTOMER', 'cust-1', {
      name: 'Alice',
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

        // Step 2: Wait for both read models to be projected
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
        // Step 3: Verify initial state
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

        // Step 4: Clear orders_overview to simulate from-scratch replay
        return cleanupClient
          .db('iso-readmodels')
          .collection('orders_overview')
          .deleteMany({});
      })
      .then(() =>
        // Step 5: Start replay for overview WITH targetServiceId
        fetchAdmin('/api/admin/startReplay', {
          method: 'POST',
          body: JSON.stringify({
            readModel: 'overview',
            fromTimestamp: 0,
            targetServiceId: 'ISO-ORDERS',
          }),
        }),
      )
      .then(({ status, body }) => {
        expect(status).toBe(200);
        expect(body.status).toBe('started');

        // Step 6: Wait for orders to be re-projected (admin delegates
        // replay to CP via event bus, so we check data directly)
        return waitForCondition(() =>
          getCollection('orders_overview').then(
            (orders) => orders.length === 2,
          ),
        );
      })
      .then(() =>
        // Step 8: Verify customers were NOT duplicated
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

  test('replaying without targetServiceId affects all services with matching read model name (backward compat)', () => {
    // Clear both collections
    const db = cleanupClient.db('iso-readmodels');
    return db
      .collection('customers_overview')
      .deleteMany({})
      .then(() => db.collection('orders_overview').deleteMany({}))
      .then(() =>
        // Start replay WITHOUT targetServiceId
        fetchAdmin('/api/admin/startReplay', {
          method: 'POST',
          body: JSON.stringify({
            readModel: 'overview',
            fromTimestamp: 0,
          }),
        }),
      )
      .then(({ status, body }) => {
        expect(status).toBe(200);
        expect(body.status).toBe('started');

        // Wait for both services to project (admin delegates replay
        // to CP via event bus, so we check data directly)
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
        Promise.all([
          getCollection('customers_overview'),
          getCollection('orders_overview'),
        ]),
      )
      .then(([customers, orders]) => {
        // Without targetServiceId, both services should have processed
        // the replay events (backward compatible behavior)
        expect(customers).toHaveLength(2);
        expect(orders).toHaveLength(2);
      });
  });
});
