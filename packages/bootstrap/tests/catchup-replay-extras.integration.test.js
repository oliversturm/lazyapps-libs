import { describe, test, expect, vi, beforeAll, afterAll } from 'vitest';
import { MongoDBContainer } from '@testcontainers/mongodb';
import { MongoClient } from 'mongodb';
import expressApp from 'express';
import bodyParser from 'body-parser';
import { createServer } from 'node:net';

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
const { registerSharedMqEmitter, getSharedMqEmitter } =
  await import('@lazyapps/mqemitter');
const { mongodb: eventStoreMongo } =
  await import('@lazyapps/eventstore-mongodb');
const { mongodb: readModelStorageMongo } =
  await import('@lazyapps/readmodelstorage-mongodb');
const {
  commandProcessorEventBusMqEmitter,
  readModelEventBusMqEmitter,
  readModelListenerMqEmitter,
} = await import('@lazyapps/mqemitter');
const { createCatchupHandler } =
  await import('@lazyapps/command-processor/catchupHandler.js');
const { createReplayHandler } =
  await import('@lazyapps/command-processor/replayHandler.js');
const { createCpStatusTracker } =
  await import('@lazyapps/command-processor/cpStatusTracker.js');
const { initializeContext } = await import('@lazyapps/readmodels/context.js');
const { installReadModelStatusApi } = await import('@lazyapps/admin-api');
const { installAdminEndpoints } = await import('@lazyapps/readmodels');
const { startAdmin } = await import('../admin.js');

import { waitForCondition } from './helpers/waitForCondition.js';

const getPort = () =>
  new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });

const createInlineAdminInstructionHandler = (context) => {
  return (correlationId, instruction) => {
    const lm = context.lifecycleManager;
    switch (instruction.type) {
      case 'activate':
        if (instruction.targetReadModel && lm) {
          lm.activate(instruction.targetReadModel, correlationId).catch(
            () => {},
          );
        }
        break;
      case 'stop':
        if (instruction.targetReadModel && lm) {
          lm.stop(instruction.targetReadModel, correlationId);
        }
        break;
      case 'catchupDone': {
        if (instruction.targetReadModel && lm) {
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
        if (instruction.targetReadModel && lm) {
          lm.startReplay(instruction.targetReadModel, correlationId).catch(
            () => {},
          );
        }
        break;
      case 'replayDone':
        if (instruction.targetReadModel && lm) {
          lm.replayDone(instruction.targetReadModel, correlationId);
        }
        break;
      case 'reset':
        if (instruction.targetReadModel) {
          const rmDef = context.readModels[instruction.targetReadModel];
          const colNames = rmDef?.collections || [instruction.targetReadModel];
          colNames
            .reduce(
              (chain, col) =>
                chain.then(() =>
                  context.storage
                    .dropCollection(correlationId, col)
                    .catch(() => {}),
                ),
              Promise.resolve(),
            )
            .then(() => {
              if (context.statusTracker) {
                context.statusTracker.immediatePush(
                  instruction.targetReadModel,
                );
              }
            });
        }
        break;
    }
  };
};

const setupTestEnv = (mqPrefix, dbPrefix, readModelDefs, options = {}) => {
  const env = {
    container: null,
    connectionString: null,
    cleanupClient: null,
    adminServer: null,
    adminPort: null,
    rmAdminServer: null,
    rmAdminPort: null,
    cpServer: null,
    cpPort: null,
    rmContext: null,
    cpEventStore: null,
  };

  const setup = () => {
    console.log(`[ENV ${dbPrefix}] Registering mqemitters: ${mqPrefix}-events, ${mqPrefix}-queries`);
    registerSharedMqEmitter(`${mqPrefix}-events`, mqemitter());
    registerSharedMqEmitter(`${mqPrefix}-queries`, mqemitter());

    return getPort()
      .then((adminPort) => {
        env.adminPort = adminPort;
        console.log(`[ENV ${dbPrefix}] Admin port: ${adminPort}`);
        return new MongoDBContainer('mongo:7').start();
      })
      .then((c) => {
        env.container = c;
        env.connectionString =
          c.getConnectionString() + '?directConnection=true';
        console.log(`[ENV ${dbPrefix}] MongoDB: ${env.connectionString}`);
        return MongoClient.connect(env.connectionString);
      })
      .then((client) => {
        env.cleanupClient = client;
        console.log(`[ENV ${dbPrefix}] RM storage database: ${dbPrefix}-rm`);

        const changeNotificationSender = options.changeNotificationSender || {
          sendChangeNotification: () => () => Promise.resolve(),
        };

        return initializeContext(
          { serviceId: `${dbPrefix}-RM` },
          {
            readModels: readModelDefs,
            endpointName: 'rm',
            storage: readModelStorageMongo({
              url: env.connectionString,
              database: `${dbPrefix}-rm`,
            }),
            eventBus: readModelEventBusMqEmitter({
              mqName: `${mqPrefix}-events`,
            }),
            changeNotificationSender,
            commandSender: {
              sendCommand: () => () => Promise.resolve(),
            },
            lifecycle: true,
          },
        );
      })
      .then((context) => {
        env.rmContext = context;
        console.log(`[ENV ${dbPrefix}] RM context initialized, lifecycle: ${!!context.lifecycleManager}`);
        context.adminInstructionHandler =
          createInlineAdminInstructionHandler(context);

        return readModelListenerMqEmitter({
          mqName: `${mqPrefix}-queries`,
        })(context);
      })
      .then(() => {
        const app = expressApp();
        app.use(bodyParser.json());
        installReadModelStatusApi(env.rmContext)(app);
        installAdminEndpoints(env.rmContext, app);

        return new Promise((resolve, reject) => {
          env.rmAdminServer = app.listen(0, '127.0.0.1');
          env.rmAdminServer.on('listening', () => {
            env.rmAdminPort = env.rmAdminServer.address().port;
            console.log(`[ENV ${dbPrefix}] RM admin server on port ${env.rmAdminPort}`);
            resolve();
          });
          env.rmAdminServer.on('error', reject);
        });
      })
      .then(() => {
        console.log(`[ENV ${dbPrefix}] CP event store database: ${dbPrefix}-events`);
        const cpEventStoreFactory = eventStoreMongo({
          url: env.connectionString,
          database: `${dbPrefix}-events`,
        });
        const cpEventBusFactory = commandProcessorEventBusMqEmitter({
          mqName: `${mqPrefix}-events`,
        });
        const cpStatusTracker = createCpStatusTracker();

        return Promise.all([cpEventStoreFactory(), cpEventBusFactory()]).then(
          ([cpEventStore, cpEventBus]) => {
            env.cpEventStore = cpEventStore;
            env.cpEventBus = cpEventBus;
            env.cpStatusTracker = cpStatusTracker;

            const catchupHandler = createCatchupHandler(
              cpEventStore,
              cpEventBus,
              cpStatusTracker,
            );

            const replayHandler = createReplayHandler(
              cpEventStore,
              cpEventBus,
              cpStatusTracker,
            );

            const mq = getSharedMqEmitter('CP', `${mqPrefix}-events`);
            mq.on('__admin', ({ payload }, cb) => {
              const { correlationId, instruction } = payload;
              switch (instruction.type) {
                case 'startCatchup':
                  catchupHandler
                    .startCatchup(
                      correlationId,
                      instruction.readModel,
                      instruction.fromTimestamp || 0,
                      instruction.targetEndpointName,
                      instruction.replayRelevantEvents,
                    )
                    .catch(() => {});
                  break;
                case 'cancelCatchup':
                  catchupHandler.cancelCatchup(
                    correlationId,
                    instruction.readModel,
                  );
                  break;
                case 'replay':
                  replayHandler
                    .startReplay(
                      correlationId,
                      instruction.readModel,
                      instruction.fromTimestamp || 0,
                      instruction.toTimestamp || 0,
                      instruction.targetEndpointName,
                      instruction.replayRelevantEvents,
                    )
                    .catch(() => {});
                  break;
                case 'cancelReplay':
                  replayHandler
                    .cancelReplay(correlationId, instruction.readModel)
                    .catch(() => {});
                  break;
              }
              cb();
            });

            // RM-side admin instruction handler
            const rmMq = getSharedMqEmitter('RM', `${mqPrefix}-events`);
            rmMq.on('__admin', ({ payload }, cb) => {
              const { correlationId, instruction } = payload;
              env.rmContext.adminInstructionHandler(
                correlationId,
                instruction,
              );
              cb();
            });

            const cpApp = expressApp();
            cpApp.use(bodyParser.json());
            cpApp.get('/admin/commandprocessor/status', (req, res) => {
              res.json(cpStatusTracker.getStatus());
            });
            cpApp.get('/admin/commandprocessor/events', (req, res) => {
              res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
              });
              res.write('\n');
              const status = cpStatusTracker.getStatus();
              res.write(
                `event: status-change\ndata: ${JSON.stringify(status)}\n\n`,
              );
              cpStatusTracker.addSseClient(res);
              req.on('close', () => {
                cpStatusTracker.removeSseClient(res);
              });
            });
            cpApp.get('/admin/eventstore/lastTimestamp', (req, res) => {
              cpEventStore
                .getLatestEventTimestamp()
                .then((ts) => {
                  res.json({ lastTimestamp: ts });
                })
                .catch(() => {
                  res.status(500).json({ error: 'Failed to query' });
                });
            });

            return new Promise((resolve, reject) => {
              env.cpServer = cpApp.listen(0, '127.0.0.1');
              env.cpServer.on('listening', () => {
                env.cpPort = env.cpServer.address().port;
                console.log(`[ENV ${dbPrefix}] CP server on port ${env.cpPort}`);
                resolve();
              });
              env.cpServer.on('error', reject);
            });
          },
        );
      })
      .then(() => {
        console.log(`[ENV ${dbPrefix}] Starting admin service on port ${env.adminPort}`);
        console.log(`[ENV ${dbPrefix}] Admin → RM: http://127.0.0.1:${env.rmAdminPort}`);
        console.log(`[ENV ${dbPrefix}] Admin → CP: http://127.0.0.1:${env.cpPort}`);
        return startAdmin(
          { serviceId: `${dbPrefix}-TEST` },
          {
            port: env.adminPort,
            eventBus: commandProcessorEventBusMqEmitter({
              mqName: `${mqPrefix}-events`,
            }),
            readModelServiceUrl: `http://127.0.0.1:${env.rmAdminPort}`,
            commandProcessorUrl: `http://127.0.0.1:${env.cpPort}`,
          },
        );
      })
      .then((server) => {
        env.adminServer = server;
        console.log(`[ENV ${dbPrefix}] Admin service started, setup complete`);
      });
  };

  const teardown = () =>
    Promise.resolve()
      .then(() => {
        if (env.adminServer && env.adminServer.__testing__) {
          env.adminServer.__testing__.sseClient.disconnectAll();
        }
      })
      .then(() =>
        env.rmAdminServer
          ? new Promise((r) => env.rmAdminServer.close(r))
          : undefined,
      )
      .then(() =>
        env.cpServer ? new Promise((r) => env.cpServer.close(r)) : undefined,
      )
      .then(() =>
        env.adminServer
          ? new Promise((r) => env.adminServer.close(r))
          : undefined,
      )
      .then(() => (env.cleanupClient ? env.cleanupClient.close() : undefined))
      .then(() => (env.container ? env.container.stop() : undefined));

  return { env, setup, teardown };
};

// ── 2.3: replayRelevantEvents filter ────────────────────────────────────
// Only matching events are projected during catch-up and replay.

describe(
  'replayRelevantEvents filter during catch-up and replay',
  { timeout: 60000 },
  () => {
    // Define two read models: one that only cares about ITEM_CREATED,
    // and events that include both ITEM_CREATED and ORDER_CREATED.
    const readModelDefs = {
      items: {
        projections: {
          ITEM_CREATED: ({ storage }, event) =>
            storage.updateOne(
              'items_col',
              { id: event.aggregateId },
              {
                $set: {
                  id: event.aggregateId,
                  name: event.payload.name,
                  ts: event.timestamp,
                },
              },
              { upsert: true },
            ),
          // This projection exists but should NOT be triggered during
          // catch-up/replay because ORDER_CREATED is not in replayRelevantEvents
          ORDER_CREATED: ({ storage }, event) =>
            storage.updateOne(
              'orders_col',
              { id: event.aggregateId },
              {
                $set: {
                  id: event.aggregateId,
                  name: event.payload.name,
                  ts: event.timestamp,
                },
              },
              { upsert: true },
            ),
        },
        resolvers: {
          all: (storage) =>
            storage.find('items_col', {}).project({ _id: 0 }).toArray(),
        },
        collections: ['items_col', 'orders_col'],
        replayRelevantEvents: ['ITEM_CREATED'],
      },
    };

    const { env, setup, teardown } = setupTestEnv(
      'rre-filt',
      'rre-filt',
      readModelDefs,
    );

    beforeAll(setup);
    afterAll(teardown);

    const fetchAdmin = (path, options = {}) =>
      fetch(`http://127.0.0.1:${env.adminPort}${path}`, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
      }).then((res) =>
        res.json().then((body) => ({ status: res.status, body })),
      );

    const fetchRM = (path) =>
      fetch(`http://127.0.0.1:${env.rmAdminPort}${path}`, {
        headers: { 'Content-Type': 'application/json' },
      }).then((res) =>
        res.json().then((body) => ({ status: res.status, body })),
      );

    const insertEvents = (events) =>
      env.cleanupClient
        .db('rre-filt-events')
        .collection('events')
        .insertMany(events);

    const rmDb = () => env.cleanupClient.db('rre-filt-rm');

    test('catch-up only projects replayRelevantEvents, not other event types', () =>
      // Insert mixed events: 3 ITEM_CREATED + 2 ORDER_CREATED
      insertEvents([
        {
          type: 'ITEM_CREATED',
          aggregateId: 'item-1',
          timestamp: 1000,
          payload: { name: 'Item 1' },
        },
        {
          type: 'ORDER_CREATED',
          aggregateId: 'order-1',
          timestamp: 2000,
          payload: { name: 'Order 1' },
        },
        {
          type: 'ITEM_CREATED',
          aggregateId: 'item-2',
          timestamp: 3000,
          payload: { name: 'Item 2' },
        },
        {
          type: 'ORDER_CREATED',
          aggregateId: 'order-2',
          timestamp: 4000,
          payload: { name: 'Order 2' },
        },
        {
          type: 'ITEM_CREATED',
          aggregateId: 'item-3',
          timestamp: 5000,
          payload: { name: 'Item 3' },
        },
      ])
        .then(() =>
          waitForCondition(() =>
            fetchAdmin('/admin/readmodel/status').then(
              ({ body }) => body.length > 0 ? true : 'no read models yet',
            ), 5000, 100, 'admin sees RM',
          ),
        )
        // Activate items RM → catch-up should only process ITEM_CREATED
        .then(() =>
          fetchAdmin('/admin/readmodel/activate/rm/items', {
            method: 'POST',
            body: '{}',
          }),
        )
        .then(() =>
          waitForCondition(() =>
            fetchRM('/admin/readmodel').then(({ body }) => {
              const items = body.find((rm) => rm.name === 'items');
              if (items && items.state === 'live') return true;
              return `state=${items?.state || 'not found'}`;
            }), 5000, 100, 'items → live',
          ),
        )
        // Verify: items_col has 3 ITEM_CREATED events
        .then(() =>
          rmDb()
            .collection('items_col')
            .find({}, { projection: { _id: 0 } })
            .toArray(),
        )
        .then((items) => {
          expect(items).toHaveLength(3);
        })
        // Verify: orders_col has 0 documents — ORDER_CREATED was filtered out
        .then(() => rmDb().collection('orders_col').countDocuments())
        .then((count) => {
          expect(count).toBe(0);
        })
        // Now stop, replay from scratch, and verify same filtering
        .then(() =>
          fetchAdmin('/admin/readmodel/stop/rm/items', {
            method: 'POST',
            body: '{}',
          }),
        )
        .then(() =>
          waitForCondition(() =>
            fetchRM('/admin/readmodel').then(({ body }) => {
              const items = body.find((rm) => rm.name === 'items');
              if (items && items.state === 'idle') return true;
              return `state=${items?.state || 'not found'}`;
            }), 5000, 100, 'items → idle',
          ),
        )
        // Start replay with activateAfter
        .then(() =>
          fetchAdmin('/admin/replay/start/rm/items', {
            method: 'POST',
            body: JSON.stringify({ activateAfter: true }),
          }),
        )
        .then(({ status }) => {
          expect(status).toBe(202);
          return waitForCondition(
            () =>
              fetchRM('/admin/readmodel').then(({ body }) => {
                const items = body.find((rm) => rm.name === 'items');
                if (items && items.state === 'live') return true;
                return `state=${items?.state || 'not found'}`;
              }),
            30000, 100, 'items → live (replay)',
          );
        })
        // After replay + catch-up, items_col should still have 3 items
        .then(() =>
          rmDb()
            .collection('items_col')
            .find({}, { projection: { _id: 0 } })
            .toArray(),
        )
        .then((items) => {
          expect(items).toHaveLength(3);
        })
        // orders_col should still have 0 — ORDER_CREATED was filtered during replay too
        .then(() => rmDb().collection('orders_col').countDocuments())
        .then((count) => {
          expect(count).toBe(0);
        }));
  },
);

// ── 2.4-2.5: Change notification suppression during catch-up ────────────

describe(
  'change notification suppression during catch-up',
  { timeout: 60000 },
  () => {
    const notificationCalls = [];
    const changeNotificationSender = {
      sendChangeNotification: () => (changeInfo) => {
        notificationCalls.push(changeInfo);
        return Promise.resolve();
      },
    };

    const readModelDefs = {
      items: {
        projections: {
          ITEM_CREATED: ({ storage, changeNotification }, event) =>
            storage
              .updateOne(
                'items_cn',
                { id: event.aggregateId },
                {
                  $set: {
                    id: event.aggregateId,
                    name: event.payload.name,
                    ts: event.timestamp,
                  },
                },
                { upsert: true },
              )
              .then(() =>
                changeNotification.sendChangeNotification(
                  changeNotification.createChangeInfo('items', {
                    type: 'ITEM_CREATED',
                    id: event.aggregateId,
                  }),
                ),
              ),
        },
        resolvers: {
          all: (storage) =>
            storage.find('items_cn', {}).project({ _id: 0 }).toArray(),
        },
        collections: ['items_cn'],
        replayRelevantEvents: ['ITEM_CREATED'],
      },
    };

    const { env, setup, teardown } = setupTestEnv(
      'cn-supp',
      'cn-supp',
      readModelDefs,
      { changeNotificationSender },
    );

    beforeAll(setup);
    afterAll(teardown);

    const fetchAdmin = (path, options = {}) =>
      fetch(`http://127.0.0.1:${env.adminPort}${path}`, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
      }).then((res) =>
        res.json().then((body) => ({ status: res.status, body })),
      );

    const fetchRM = (path) =>
      fetch(`http://127.0.0.1:${env.rmAdminPort}${path}`, {
        headers: { 'Content-Type': 'application/json' },
      }).then((res) =>
        res.json().then((body) => ({ status: res.status, body })),
      );

    const insertEvents = (events) =>
      env.cleanupClient
        .db('cn-supp-events')
        .collection('events')
        .insertMany(events);

    const rmDb = () => env.cleanupClient.db('cn-supp-rm');

    test('change notifications suppressed during catch-up, resumed during live', () =>
      // Insert initial events
      insertEvents(
        Array.from({ length: 3 }, (_, i) => ({
          type: 'ITEM_CREATED',
          aggregateId: `item-${i + 1}`,
          timestamp: (i + 1) * 1000,
          payload: { name: `Item ${i + 1}` },
        })),
      )
        .then(() =>
          waitForCondition(() =>
            fetchAdmin('/admin/readmodel/status').then(
              ({ body }) => body.length > 0 ? true : 'no read models yet',
            ), 5000, 100, 'admin sees RM',
          ),
        )
        // Clear any previous notification calls
        .then(() => {
          notificationCalls.length = 0;
        })
        // Activate → catch-up should NOT send change notifications
        .then(() =>
          fetchAdmin('/admin/readmodel/activate/rm/items', {
            method: 'POST',
            body: '{}',
          }),
        )
        .then(() =>
          waitForCondition(() =>
            fetchRM('/admin/readmodel').then(({ body }) => {
              const items = body.find((rm) => rm.name === 'items');
              if (items && items.state === 'live') return true;
              return `state=${items?.state || 'not found'}`;
            }), 5000, 100, 'items → live',
          ),
        )
        // Verify data was projected
        .then(() =>
          rmDb()
            .collection('items_cn')
            .find({}, { projection: { _id: 0 } })
            .toArray(),
        )
        .then((items) => {
          expect(items).toHaveLength(3);
        })
        // 2.4: Verify NO change notifications were sent during catch-up
        .then(() => {
          expect(notificationCalls).toHaveLength(0);
        })
        // 2.5: Now send a live event and verify notification IS sent
        .then(() => {
          const mq = getSharedMqEmitter('cn-live', 'cn-supp-events');
          return new Promise((resolve) => {
            mq.emit(
              {
                topic: 'events',
                payload: {
                  correlationId: 'cn-live-test',
                  type: 'ITEM_CREATED',
                  aggregateId: 'item-4',
                  timestamp: 4000,
                  payload: { name: 'Item 4' },
                },
              },
              resolve,
            );
          });
        })
        // Wait for live event to be projected
        .then(() =>
          waitForCondition(() =>
            rmDb()
              .collection('items_cn')
              .countDocuments()
              .then((c) => c === 4 ? true : `count=${c}`),
            5000, 100, 'items_cn count=4',
          ),
        )
        // 2.5: Verify change notification WAS sent for live event
        .then(() => {
          expect(notificationCalls.length).toBeGreaterThan(0);
        }));
  },
);

// ── 3.4: New events during replay, catch-up picks them up ───────────────

describe(
  'new events during replay are picked up by catch-up',
  { timeout: 60000 },
  () => {
    const readModelDefs = {
      items: {
        projections: {
          ITEM_CREATED: ({ storage }, event) =>
            storage.updateOne(
              'items_gap',
              { id: event.aggregateId },
              {
                $set: {
                  id: event.aggregateId,
                  name: event.payload.name,
                  ts: event.timestamp,
                },
              },
              { upsert: true },
            ),
        },
        resolvers: {
          all: (storage) =>
            storage.find('items_gap', {}).project({ _id: 0 }).toArray(),
        },
        collections: ['items_gap'],
        replayRelevantEvents: ['ITEM_CREATED'],
      },
    };

    const { env, setup, teardown } = setupTestEnv(
      'rpl-gap2',
      'rpl-gap2',
      readModelDefs,
    );

    beforeAll(setup);
    afterAll(teardown);

    const fetchAdmin = (path, options = {}) =>
      fetch(`http://127.0.0.1:${env.adminPort}${path}`, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
      }).then((res) =>
        res.json().then((body) => ({ status: res.status, body })),
      );

    const fetchRM = (path) =>
      fetch(`http://127.0.0.1:${env.rmAdminPort}${path}`, {
        headers: { 'Content-Type': 'application/json' },
      }).then((res) =>
        res.json().then((body) => ({ status: res.status, body })),
      );

    const insertEvents = (events) =>
      env.cleanupClient
        .db('rpl-gap2-events')
        .collection('events')
        .insertMany(events);

    const rmDb = () => env.cleanupClient.db('rpl-gap2-rm');

    test('events added during replay are caught up after replay completes', () =>
      // Insert initial events
      insertEvents(
        Array.from({ length: 3 }, (_, i) => ({
          type: 'ITEM_CREATED',
          aggregateId: `item-${i + 1}`,
          timestamp: (i + 1) * 1000,
          payload: { name: `Item ${i + 1}` },
        })),
      )
        .then(() =>
          waitForCondition(() =>
            fetchAdmin('/admin/readmodel/status').then(
              ({ body }) => body.length > 0 ? true : 'no read models yet',
            ), 5000, 100, 'admin sees RM',
          ),
        )
        // Activate → live with 3 events
        .then(() =>
          fetchAdmin('/admin/readmodel/activate/rm/items', {
            method: 'POST',
            body: '{}',
          }),
        )
        .then(() =>
          waitForCondition(() =>
            fetchRM('/admin/readmodel').then(({ body }) => {
              const items = body.find((rm) => rm.name === 'items');
              if (items && items.state === 'live') return true;
              return `state=${items?.state || 'not found'}`;
            }), 5000, 100, 'items → live',
          ),
        )
        // Stop the RM
        .then(() =>
          fetchAdmin('/admin/readmodel/stop/rm/items', {
            method: 'POST',
            body: '{}',
          }),
        )
        .then(() =>
          waitForCondition(() =>
            fetchRM('/admin/readmodel').then(({ body }) => {
              const items = body.find((rm) => rm.name === 'items');
              if (items && items.state === 'idle') return true;
              return `state=${items?.state || 'not found'}`;
            }), 5000, 100, 'items → idle',
          ),
        )
        // Add new events while RM is stopped (these will be "during replay")
        .then(() =>
          insertEvents(
            Array.from({ length: 2 }, (_, i) => ({
              type: 'ITEM_CREATED',
              aggregateId: `item-${i + 4}`,
              timestamp: (i + 4) * 1000,
              payload: { name: `Item ${i + 4}` },
            })),
          ),
        )
        // Start replay with auto-activate — replay processes events to
        // timestamp 3000 (the RM's last projected timestamp), and catch-up
        // should pick up events 4000 and 5000.
        .then(() =>
          fetchAdmin('/admin/replay/start/rm/items', {
            method: 'POST',
            body: JSON.stringify({ activateAfter: true }),
          }),
        )
        .then(({ status }) => {
          expect(status).toBe(202);
          return waitForCondition(
            () =>
              fetchRM('/admin/readmodel').then(({ body }) => {
                const items = body.find((rm) => rm.name === 'items');
                if (items && items.state === 'live') return true;
                return `state=${items?.state || 'not found'}`;
              }),
            30000, 100, 'items → live (replay)',
          );
        })
        // Verify all 5 items present (3 from replay + 2 from catch-up)
        .then(() =>
          waitForCondition(
            () =>
              rmDb()
                .collection('items_gap')
                .countDocuments()
                .then((c) => c === 5 ? true : `count=${c}`),
            5000, 100, 'items_gap count=5',
          ),
        )
        .then(() =>
          rmDb()
            .collection('items_gap')
            .find({}, { projection: { _id: 0 } })
            .toArray(),
        )
        .then((items) => {
          expect(items).toHaveLength(5);
          const ids = items.map((i) => i.id).sort();
          expect(ids).toEqual([
            'item-1',
            'item-2',
            'item-3',
            'item-4',
            'item-5',
          ]);
        })
        // Verify timestamp includes catch-up events
        .then(() =>
          rmDb().collection('readmodel.state').findOne({ name: 'items' }),
        )
        .then((stateDoc) => {
          expect(stateDoc.lastProjectedEventTimestamp).toBe(5000);
        }));
  },
);
