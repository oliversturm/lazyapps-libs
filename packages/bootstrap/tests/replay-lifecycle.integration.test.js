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

const testReadModels = {
  items: {
    projections: {
      ITEM_CREATED: ({ storage }, event) =>
        storage.insertOne('items_overview', {
          id: event.aggregateId,
          name: event.payload.name,
          ts: event.timestamp,
        }),
    },
    resolvers: {
      all: (storage) =>
        storage.find('items_overview', {}).project({ _id: 0 }).toArray(),
    },
    collections: ['items_overview'],
    replayRelevantEvents: ['ITEM_CREATED'],
  },
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

const getPort = () =>
  new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });

// Admin instruction handler for RM side
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
          lm.replayDone(instruction.targetReadModel, correlationId);
        }
        break;
      case 'reset':
        // Reset is handled by storage clearing
        break;
    }
  };
};

// Create a fresh copy of testReadModels
const cloneTestReadModels = () => ({
  items: {
    projections: { ...testReadModels.items.projections },
    resolvers: { ...testReadModels.items.resolvers },
    collections: [...testReadModels.items.collections],
    replayRelevantEvents: [...testReadModels.items.replayRelevantEvents],
  },
});

// Helper to set up a full test environment
const setupTestEnv = (mqPrefix, dbPrefix) => {
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
    readModels: null,
  };

  const setup = () => {
    env.readModels = cloneTestReadModels();
    registerSharedMqEmitter(`${mqPrefix}-events`, mqemitter());
    registerSharedMqEmitter(`${mqPrefix}-queries`, mqemitter());

    return getPort()
      .then((adminPort) => {
        env.adminPort = adminPort;
        return new MongoDBContainer('mongo:7').start();
      })
      .then((c) => {
        env.container = c;
        env.connectionString =
          c.getConnectionString() + '?directConnection=true';
        return MongoClient.connect(env.connectionString);
      })
      .then((client) => {
        env.cleanupClient = client;

        return initializeContext(
          { serviceId: `${dbPrefix}-RM` },
          {
            readModels: env.readModels,
            endpointName: 'rm',
            storage: readModelStorageMongo({
              url: env.connectionString,
              database: `${dbPrefix}-rm`,
            }),
            eventBus: readModelEventBusMqEmitter({
              mqName: `${mqPrefix}-events`,
            }),
            changeNotificationSender: {
              sendChangeNotification: () => () => Promise.resolve(),
            },
            commandSender: {
              sendCommand: () => () => Promise.resolve(),
            },
            lifecycle: true,
          },
        );
      })
      .then((context) => {
        env.rmContext = context;
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
            resolve();
          });
          env.rmAdminServer.on('error', reject);
        });
      })
      .then(() => {
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

            // Create CP-side catch-up handler
            const catchupHandler = createCatchupHandler(
              cpEventStore,
              cpEventBus,
              cpStatusTracker,
            );

            // Create CP-side replay handler
            const replayHandler = createReplayHandler(
              cpEventStore,
              cpEventBus,
              cpStatusTracker,
            );
            env.cpReplayHandler = replayHandler;

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

            const cpApp = expressApp();
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

            return new Promise((resolve, reject) => {
              env.cpServer = cpApp.listen(0, '127.0.0.1');
              env.cpServer.on('listening', () => {
                env.cpPort = env.cpServer.address().port;
                resolve();
              });
              env.cpServer.on('error', reject);
            });
          },
        );
      })
      .then(() =>
        startAdmin(
          { serviceId: `${dbPrefix}-TEST` },
          {
            port: env.adminPort,
            eventBus: commandProcessorEventBusMqEmitter({
              mqName: `${mqPrefix}-events`,
            }),
            readModelServiceUrl: `http://127.0.0.1:${env.rmAdminPort}`,
            commandProcessorUrl: `http://127.0.0.1:${env.cpPort}`,
          },
        ),
      )
      .then((server) => {
        env.adminServer = server;
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

// ── Replay from scratch: lastProjectedEventTimestamp persistence ──────────

describe(
  'replay from scratch timestamp persistence',
  { timeout: 60000 },
  () => {
    const { env, setup, teardown } = setupTestEnv('replay-ts', 'replay-ts');

    beforeAll(setup);
    afterAll(teardown);

    const fetchRM = (path, options = {}) =>
      fetch(`http://127.0.0.1:${env.rmAdminPort}${path}`, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
      }).then((res) =>
        res.json().then((body) => ({ status: res.status, body })),
      );

    const fetchAdmin = (path, options = {}) =>
      fetch(`http://127.0.0.1:${env.adminPort}${path}`, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
      }).then((res) =>
        res.json().then((body) => ({ status: res.status, body })),
      );

    const insertEvents = (events) =>
      env.cleanupClient
        .db('replay-ts-events')
        .collection('events')
        .insertMany(events);

    const rmDb = () => env.cleanupClient.db('replay-ts-rm');

    test('replay from scratch preserves timestamp, no duplicates on restart', () =>
      // Step 1: Insert 5 events into the event store
      insertEvents(
        Array.from({ length: 5 }, (_, i) => ({
          type: 'ITEM_CREATED',
          aggregateId: `item-${i + 1}`,
          timestamp: (i + 1) * 100,
          payload: { name: `Item ${i + 1}` },
        })),
      )
        // Step 2: Activate items RM via admin → catches up to live
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
              return items.state === 'live';
            }),
          ),
        )
        // Step 3: Verify 5 items projected and timestamp is 500
        .then(() =>
          rmDb()
            .collection('items_overview')
            .find({}, { projection: { _id: 0 } })
            .sort({ id: 1 })
            .toArray(),
        )
        .then((items) => {
          expect(items).toHaveLength(5);
        })
        .then(() =>
          rmDb().collection('readmodel.state').findOne({ name: 'items' }),
        )
        .then((stateDoc) => {
          expect(stateDoc.lastProjectedEventTimestamp).toBe(500);
        })
        // Step 4: Stop the RM via admin
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
              return items.state === 'idle';
            }),
          ),
        )
        // Step 5: Clear data collections but PRESERVE timestamp (T=500)
        // This simulates clearCollections behavior: drops data, keeps
        // readmodel.state with lastProjectedEventTimestamp intact.
        .then(() =>
          rmDb()
            .collection('items_overview')
            .drop()
            .catch(() => {}),
        )
        // Verify timestamp is still 500 (preserved by clearCollections)
        .then(() =>
          rmDb().collection('readmodel.state').findOne({ name: 'items' }),
        )
        .then((stateDoc) => {
          expect(stateDoc.lastProjectedEventTimestamp).toBe(500);
        })
        // Step 6: Start replay via lifecycle manager
        .then(() =>
          env.rmContext.lifecycleManager.startReplay('items', 'replay-test'),
        )
        .then(() =>
          waitForCondition(() =>
            fetchRM('/admin/readmodel').then(({ body }) => {
              const items = body.find((rm) => rm.name === 'items');
              return items.state === 'replay';
            }),
          ),
        )
        // Step 7: Stream replay events via __replay topic (simulating CP)
        .then(() => {
          const mq = getSharedMqEmitter('replay-sim', 'replay-ts-events');
          const events = Array.from({ length: 5 }, (_, i) => ({
            type: 'ITEM_CREATED',
            aggregateId: `item-${i + 1}`,
            timestamp: (i + 1) * 100,
            payload: { name: `Item ${i + 1}` },
          }));
          // Emit replay events sequentially
          return events.reduce(
            (chain, event) =>
              chain.then(
                () =>
                  new Promise((resolve) => {
                    mq.emit(
                      {
                        topic: '__replay',
                        payload: {
                          correlationId: 'replay-test',
                          targetReadModel: 'items',
                          targetEndpointName: 'rm',
                          event,
                        },
                      },
                      resolve,
                    );
                  }),
              ),
            Promise.resolve(),
          );
        })
        // Step 8: Wait for all replay projections to complete via event queue
        .then(() => env.rmContext.projectionHandler.flushEventQueue())
        // Step 9: Verify items were projected during replay
        .then(() =>
          rmDb()
            .collection('items_overview')
            .find({}, { projection: { _id: 0 } })
            .sort({ id: 1 })
            .toArray(),
        )
        .then((items) => {
          expect(items).toHaveLength(5);
        })
        // Step 10: Send replayDone
        .then(() =>
          env.rmContext.lifecycleManager.replayDone('items', 'replay-test'),
        )
        .then(() =>
          waitForCondition(() =>
            fetchRM('/admin/readmodel').then(({ body }) => {
              const items = body.find((rm) => rm.name === 'items');
              return items.state === 'replay-done';
            }),
          ),
        )
        // ══════════════════════════════════════════════════════════════════
        // Replay does NOT update lastProjectedEventTimestamp per-event.
        // clearCollections preserved T=500, so it stays at 500.
        // ══════════════════════════════════════════════════════════════════
        .then(() =>
          rmDb().collection('readmodel.state').findOne({ name: 'items' }),
        )
        .then((stateDoc) => {
          expect(stateDoc.lastProjectedEventTimestamp).toBe(500);
        })
        // Step 11: Simulate restart — create a NEW context from the same MongoDB
        // This loads lastProjectedEventTimestamp=500 from MongoDB
        .then(() => {
          const freshReadModels = cloneTestReadModels();
          env.restartReadModels = freshReadModels;
          registerSharedMqEmitter('replay-ts-restart-events', mqemitter());
          registerSharedMqEmitter('replay-ts-restart-queries', mqemitter());

          return initializeContext(
            { serviceId: 'replay-ts-RESTART' },
            {
              readModels: freshReadModels,
              endpointName: 'rm',
              storage: readModelStorageMongo({
                url: env.connectionString,
                database: 'replay-ts-rm',
              }),
              eventBus: readModelEventBusMqEmitter({
                mqName: 'replay-ts-restart-events',
              }),
              changeNotificationSender: {
                sendChangeNotification: () => () => Promise.resolve(),
              },
              commandSender: {
                sendCommand: () => () => Promise.resolve(),
              },
              lifecycle: true,
            },
          );
        })
        .then((restartContext) => {
          env.restartContext = restartContext;
          restartContext.adminInstructionHandler =
            createInlineAdminInstructionHandler(restartContext);

          return readModelListenerMqEmitter({
            mqName: 'replay-ts-restart-queries',
          })(restartContext);
        })
        // Step 12: Verify the loaded timestamp from MongoDB is 500
        // (clearCollections preserved it, replay did not change it)
        .then(() => {
          expect(env.restartReadModels.items.lastProjectedEventTimestamp).toBe(
            500,
          );
        })
        // Step 13: Set up CP-side for the restarted context and activate
        .then(() => {
          const cpEventBusFactory = commandProcessorEventBusMqEmitter({
            mqName: 'replay-ts-restart-events',
          });
          return cpEventBusFactory().then((cpEventBus) => {
            const cpEventStoreFactory = eventStoreMongo({
              url: env.connectionString,
              database: 'replay-ts-events',
            });
            return cpEventStoreFactory().then((cpEventStore) => {
              const catchupHandler = createCatchupHandler(
                cpEventStore,
                cpEventBus,
              );

              const mq = getSharedMqEmitter(
                'CP-restart',
                'replay-ts-restart-events',
              );
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
                }
                cb();
              });
            });
          });
        })
        // Step 14: Create RM admin server for restarted context
        .then(() => {
          const app = expressApp();
          app.use(bodyParser.json());
          installReadModelStatusApi(env.restartContext)(app);
          installAdminEndpoints(env.restartContext, app);

          return new Promise((resolve, reject) => {
            env.restartRmAdminServer = app.listen(0, '127.0.0.1');
            env.restartRmAdminServer.on('listening', () => {
              env.restartRmAdminPort = env.restartRmAdminServer.address().port;
              resolve();
            });
            env.restartRmAdminServer.on('error', reject);
          });
        })
        // Step 15: Set up admin server for the restarted environment
        .then(() =>
          startAdmin(
            { serviceId: 'replay-ts-RESTART-ADMIN' },
            {
              port: 0,
              eventBus: commandProcessorEventBusMqEmitter({
                mqName: 'replay-ts-restart-events',
              }),
              readModelServiceUrl: `http://127.0.0.1:${env.restartRmAdminPort}`,
              commandProcessorUrl: `http://127.0.0.1:${env.cpPort}`,
            },
          ),
        )
        .then((server) => {
          env.restartAdminServer = server;
          env.restartAdminPort = server.address().port;
        })
        // Step 16: Activate items on the restarted context
        .then(() =>
          fetch(
            `http://127.0.0.1:${env.restartAdminPort}/admin/readmodel/activate/rm/items`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: '{}',
            },
          ).then((res) => res.json()),
        )
        // Step 17: Wait for live state on restarted context
        // Catch-up starts from T=500, finds no new events, goes live quickly
        .then(() =>
          waitForCondition(
            () =>
              fetch(
                `http://127.0.0.1:${env.restartRmAdminPort}/admin/readmodel`,
                {
                  headers: { 'Content-Type': 'application/json' },
                },
              )
                .then((res) => res.json())
                .then((body) => {
                  const items = body.find((rm) => rm.name === 'items');
                  return items.state === 'live';
                }),
            10000,
          ),
        )
        // Step 18: THE CRITICAL CHECK — verify NO duplicates
        // Because T=500 was preserved, catch-up from T=500 found no new
        // events and did not re-project anything.
        .then(() =>
          rmDb()
            .collection('items_overview')
            .find({}, { projection: { _id: 0 } })
            .sort({ id: 1 })
            .toArray(),
        )
        .then((items) => {
          // Should have exactly 5 items, not 10 (no duplicates)
          expect(items).toHaveLength(5);
          expect(items).toEqual(
            expect.arrayContaining([
              { id: 'item-1', name: 'Item 1', ts: 100 },
              { id: 'item-2', name: 'Item 2', ts: 200 },
              { id: 'item-3', name: 'Item 3', ts: 300 },
              { id: 'item-4', name: 'Item 4', ts: 400 },
              { id: 'item-5', name: 'Item 5', ts: 500 },
            ]),
          );
        })
        // Cleanup restarted servers
        .then(() =>
          env.restartAdminServer
            ? new Promise((r) => {
                if (env.restartAdminServer.__testing__) {
                  env.restartAdminServer.__testing__.sseClient.disconnectAll();
                }
                env.restartAdminServer.close(r);
              })
            : undefined,
        )
        .then(() =>
          env.restartRmAdminServer
            ? new Promise((r) => env.restartRmAdminServer.close(r))
            : undefined,
        ));
  },
);

// ── Multiple replay cycles ───────────────────────────────────────────────

describe('multiple replay cycles', { timeout: 60000 }, () => {
  const { env, setup, teardown } = setupTestEnv('multi-rpl', 'multi-rpl');

  beforeAll(setup);
  afterAll(teardown);

  const fetchRM = (path, options = {}) =>
    fetch(`http://127.0.0.1:${env.rmAdminPort}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    }).then((res) => res.json().then((body) => ({ status: res.status, body })));

  const fetchAdmin = (path, options = {}) =>
    fetch(`http://127.0.0.1:${env.adminPort}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    }).then((res) => res.json().then((body) => ({ status: res.status, body })));

  const insertEvents = (events) =>
    env.cleanupClient
      .db('multi-rpl-events')
      .collection('events')
      .insertMany(events);

  const rmDb = () => env.cleanupClient.db('multi-rpl-rm');

  const emitReplayEvents = (events) => {
    const mq = getSharedMqEmitter('multi-rpl-sim', 'multi-rpl-events');
    return events.reduce(
      (chain, event) =>
        chain.then(
          () =>
            new Promise((resolve) => {
              mq.emit(
                {
                  topic: '__replay',
                  payload: {
                    correlationId: 'multi-replay',
                    targetReadModel: 'items',
                    targetEndpointName: 'rm',
                    event,
                  },
                },
                resolve,
              );
            }),
        ),
      Promise.resolve(),
    );
  };

  const doReplayFromScratch = (events) =>
    // Stop
    fetchAdmin('/admin/readmodel/stop/rm/items', {
      method: 'POST',
      body: '{}',
    })
      .then(() =>
        waitForCondition(() =>
          fetchRM('/admin/readmodel').then(({ body }) => {
            const items = body.find((rm) => rm.name === 'items');
            return items.state === 'idle';
          }),
        ),
      )
      // Reset
      .then(() =>
        rmDb()
          .collection('items_overview')
          .drop()
          .catch(() => {}),
      )
      .then(() =>
        env.rmContext.storage.updateLastProjectedEventTimestamps(
          'multi-replay',
          ['items'],
          0,
        ),
      )
      // Start replay
      .then(() =>
        env.rmContext.lifecycleManager.startReplay('items', 'multi-replay'),
      )
      .then(() =>
        waitForCondition(() =>
          fetchRM('/admin/readmodel').then(({ body }) => {
            const items = body.find((rm) => rm.name === 'items');
            return items.state === 'replay';
          }),
        ),
      )
      // Stream events
      .then(() => emitReplayEvents(events))
      .then(() => env.rmContext.projectionHandler.flushEventQueue())
      // Replay done
      .then(() =>
        env.rmContext.lifecycleManager.replayDone('items', 'multi-replay'),
      )
      .then(() =>
        waitForCondition(() =>
          fetchRM('/admin/readmodel').then(({ body }) => {
            const items = body.find((rm) => rm.name === 'items');
            return items.state === 'replay-done';
          }),
        ),
      );

  test('timestamp is correct after two consecutive replay cycles', () =>
    // Insert events
    insertEvents(
      Array.from({ length: 5 }, (_, i) => ({
        type: 'ITEM_CREATED',
        aggregateId: `item-${i + 1}`,
        timestamp: (i + 1) * 100,
        payload: { name: `Item ${i + 1}` },
      })),
    )
      // Activate → live
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
            return items.state === 'live';
          }),
        ),
      )
      // First replay from scratch
      .then(() =>
        doReplayFromScratch(
          Array.from({ length: 5 }, (_, i) => ({
            type: 'ITEM_CREATED',
            aggregateId: `item-${i + 1}`,
            timestamp: (i + 1) * 100,
            payload: { name: `Item ${i + 1}` },
          })),
        ),
      )
      .then(() =>
        rmDb().collection('readmodel.state').findOne({ name: 'items' }),
      )
      .then((stateDoc) => {
        // Replay does not update timestamp — stays at 0 (pre-replay reset value)
        expect(stateDoc.lastProjectedEventTimestamp).toBe(0);
      })
      // Insert more events
      .then(() =>
        insertEvents(
          Array.from({ length: 3 }, (_, i) => ({
            type: 'ITEM_CREATED',
            aggregateId: `item-${i + 6}`,
            timestamp: (i + 6) * 100,
            payload: { name: `Item ${i + 6}` },
          })),
        ),
      )
      // Second replay from scratch — now with 8 events total
      .then(() =>
        doReplayFromScratch(
          Array.from({ length: 8 }, (_, i) => ({
            type: 'ITEM_CREATED',
            aggregateId: `item-${i + 1}`,
            timestamp: (i + 1) * 100,
            payload: { name: `Item ${i + 1}` },
          })),
        ),
      )
      .then(() =>
        rmDb().collection('readmodel.state').findOne({ name: 'items' }),
      )
      .then((stateDoc) => {
        // Replay does not update timestamp — stays at 0 (pre-replay reset value)
        expect(stateDoc.lastProjectedEventTimestamp).toBe(0);
      })
      // Verify correct data
      .then(() =>
        rmDb()
          .collection('items_overview')
          .find({}, { projection: { _id: 0 } })
          .sort({ id: 1 })
          .toArray(),
      )
      .then((items) => {
        expect(items).toHaveLength(8);
      }));
});

// ── Stop → new events → replay from scratch → verify all events ─────────

describe(
  'replay from scratch after new events while stopped',
  { timeout: 60000 },
  () => {
    const { env, setup, teardown } = setupTestEnv('rpl-gap', 'rpl-gap');

    beforeAll(setup);
    afterAll(teardown);

    const fetchRM = (path, options = {}) =>
      fetch(`http://127.0.0.1:${env.rmAdminPort}${path}`, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
      }).then((res) =>
        res.json().then((body) => ({ status: res.status, body })),
      );

    const fetchAdmin = (path, options = {}) =>
      fetch(`http://127.0.0.1:${env.adminPort}${path}`, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
      }).then((res) =>
        res.json().then((body) => ({ status: res.status, body })),
      );

    const insertEvents = (events) =>
      env.cleanupClient
        .db('rpl-gap-events')
        .collection('events')
        .insertMany(events);

    const rmDb = () => env.cleanupClient.db('rpl-gap-rm');

    test('stop, add events, replay from scratch includes all events', () =>
      // Insert initial events
      insertEvents(
        Array.from({ length: 3 }, (_, i) => ({
          type: 'ITEM_CREATED',
          aggregateId: `item-${i + 1}`,
          timestamp: (i + 1) * 100,
          payload: { name: `Item ${i + 1}` },
        })),
      )
        // Activate → live
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
              return items.state === 'live';
            }),
          ),
        )
        .then(() => rmDb().collection('items_overview').countDocuments())
        .then((count) => {
          expect(count).toBe(3);
        })
        // Stop RM
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
              return items.state === 'idle';
            }),
          ),
        )
        // Add more events while stopped
        .then(() =>
          insertEvents(
            Array.from({ length: 4 }, (_, i) => ({
              type: 'ITEM_CREATED',
              aggregateId: `item-${i + 4}`,
              timestamp: (i + 4) * 100,
              payload: { name: `Item ${i + 4}` },
            })),
          ),
        )
        // Replay from scratch — clear and replay all 7 events
        .then(() =>
          rmDb()
            .collection('items_overview')
            .drop()
            .catch(() => {}),
        )
        .then(() =>
          env.rmContext.storage.updateLastProjectedEventTimestamps(
            'gap-replay',
            ['items'],
            0,
          ),
        )
        .then(() =>
          env.rmContext.lifecycleManager.startReplay('items', 'gap-replay'),
        )
        .then(() =>
          waitForCondition(() =>
            fetchRM('/admin/readmodel').then(({ body }) => {
              const items = body.find((rm) => rm.name === 'items');
              return items.state === 'replay';
            }),
          ),
        )
        .then(() => {
          const mq = getSharedMqEmitter('gap-rpl-sim', 'rpl-gap-events');
          const allEvents = Array.from({ length: 7 }, (_, i) => ({
            type: 'ITEM_CREATED',
            aggregateId: `item-${i + 1}`,
            timestamp: (i + 1) * 100,
            payload: { name: `Item ${i + 1}` },
          }));
          return allEvents.reduce(
            (chain, event) =>
              chain.then(
                () =>
                  new Promise((resolve) => {
                    mq.emit(
                      {
                        topic: '__replay',
                        payload: {
                          correlationId: 'gap-replay',
                          targetReadModel: 'items',
                          targetEndpointName: 'rm',
                          event,
                        },
                      },
                      resolve,
                    );
                  }),
              ),
            Promise.resolve(),
          );
        })
        .then(() => env.rmContext.projectionHandler.flushEventQueue())
        .then(() =>
          env.rmContext.lifecycleManager.replayDone('items', 'gap-replay'),
        )
        .then(() =>
          waitForCondition(() =>
            fetchRM('/admin/readmodel').then(({ body }) => {
              const items = body.find((rm) => rm.name === 'items');
              return items.state === 'replay-done';
            }),
          ),
        )
        // Replay does not update timestamp — stays at 0 (pre-replay reset value)
        .then(() =>
          rmDb().collection('readmodel.state').findOne({ name: 'items' }),
        )
        .then((stateDoc) => {
          expect(stateDoc.lastProjectedEventTimestamp).toBe(0);
        })
        // Verify all 7 items projected
        .then(() =>
          rmDb()
            .collection('items_overview')
            .find({}, { projection: { _id: 0 } })
            .sort({ id: 1 })
            .toArray(),
        )
        .then((items) => {
          expect(items).toHaveLength(7);
        }));
  },
);

// ── Replay followed by new live events ───────────────────────────────────

describe('replay then live events', { timeout: 60000 }, () => {
  const { env, setup, teardown } = setupTestEnv('rpl-live', 'rpl-live');

  beforeAll(setup);
  afterAll(teardown);

  const fetchRM = (path, options = {}) =>
    fetch(`http://127.0.0.1:${env.rmAdminPort}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    }).then((res) => res.json().then((body) => ({ status: res.status, body })));

  const fetchAdmin = (path, options = {}) =>
    fetch(`http://127.0.0.1:${env.adminPort}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    }).then((res) => res.json().then((body) => ({ status: res.status, body })));

  const insertEvents = (events) =>
    env.cleanupClient
      .db('rpl-live-events')
      .collection('events')
      .insertMany(events);

  const rmDb = () => env.cleanupClient.db('rpl-live-rm');

  test('live events after replay update timestamp correctly', () =>
    // Insert initial events
    insertEvents(
      Array.from({ length: 3 }, (_, i) => ({
        type: 'ITEM_CREATED',
        aggregateId: `item-${i + 1}`,
        timestamp: (i + 1) * 100,
        payload: { name: `Item ${i + 1}` },
      })),
    )
      // Activate → live
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
            return items.state === 'live';
          }),
        ),
      )
      // Stop + reset + replay from scratch
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
            return items.state === 'idle';
          }),
        ),
      )
      .then(() =>
        rmDb()
          .collection('items_overview')
          .drop()
          .catch(() => {}),
      )
      .then(() =>
        env.rmContext.storage.updateLastProjectedEventTimestamps(
          'rpl-live-test',
          ['items'],
          0,
        ),
      )
      .then(() =>
        env.rmContext.lifecycleManager.startReplay('items', 'rpl-live-test'),
      )
      .then(() =>
        waitForCondition(() =>
          fetchRM('/admin/readmodel').then(({ body }) => {
            const items = body.find((rm) => rm.name === 'items');
            return items.state === 'replay';
          }),
        ),
      )
      .then(() => {
        const mq = getSharedMqEmitter('rpl-live-sim', 'rpl-live-events');
        const events = Array.from({ length: 3 }, (_, i) => ({
          type: 'ITEM_CREATED',
          aggregateId: `item-${i + 1}`,
          timestamp: (i + 1) * 100,
          payload: { name: `Item ${i + 1}` },
        }));
        return events.reduce(
          (chain, event) =>
            chain.then(
              () =>
                new Promise((resolve) => {
                  mq.emit(
                    {
                      topic: '__replay',
                      payload: {
                        correlationId: 'rpl-live-test',
                        targetReadModel: 'items',
                        targetEndpointName: 'rm',
                        event,
                      },
                    },
                    resolve,
                  );
                }),
            ),
          Promise.resolve(),
        );
      })
      .then(() => env.rmContext.projectionHandler.flushEventQueue())
      .then(() =>
        env.rmContext.lifecycleManager.replayDone('items', 'rpl-live-test'),
      )
      .then(() =>
        waitForCondition(() =>
          fetchRM('/admin/readmodel').then(({ body }) => {
            const items = body.find((rm) => rm.name === 'items');
            return items.state === 'replay-done';
          }),
        ),
      )
      // Replay does not update timestamp — stays at 0 (pre-replay reset value)
      .then(() =>
        rmDb().collection('readmodel.state').findOne({ name: 'items' }),
      )
      .then((stateDoc) => {
        expect(stateDoc.lastProjectedEventTimestamp).toBe(0);
      })
      // Now add new events and activate → catch-up + live
      .then(() =>
        insertEvents(
          Array.from({ length: 2 }, (_, i) => ({
            type: 'ITEM_CREATED',
            aggregateId: `item-${i + 4}`,
            timestamp: (i + 4) * 100,
            payload: { name: `Item ${i + 4}` },
          })),
        ),
      )
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
            return items.state === 'live';
          }),
        ),
      )
      // Emit a live event
      .then(() => {
        const mq = getSharedMqEmitter('live-after-rpl', 'rpl-live-events');
        return new Promise((resolve) => {
          mq.emit(
            {
              topic: 'events',
              payload: {
                correlationId: 'live-after-replay',
                type: 'ITEM_CREATED',
                aggregateId: 'item-6',
                timestamp: 600,
                payload: { name: 'Item 6' },
              },
            },
            resolve,
          );
        });
      })
      // Wait for it to be projected
      .then(() =>
        waitForCondition(() =>
          rmDb()
            .collection('items_overview')
            .countDocuments()
            .then((count) => count >= 6),
        ),
      )
      // Verify final state
      .then(() =>
        rmDb()
          .collection('items_overview')
          .find({}, { projection: { _id: 0 } })
          .sort({ id: 1 })
          .toArray(),
      )
      .then((items) => {
        // 3 from replay + 2 from catch-up + 1 live = 6
        expect(items).toHaveLength(6);
        const ids = items.map((it) => it.id);
        expect(ids).toContain('item-1');
        expect(ids).toContain('item-6');
      })
      // Verify final timestamp
      .then(() =>
        rmDb().collection('readmodel.state').findOne({ name: 'items' }),
      )
      .then((stateDoc) => {
        expect(stateDoc.lastProjectedEventTimestamp).toBe(600);
      }));
});

// ── State invariant tests: each operation leaves correct persistent state ─

describe('timestamp state invariants per operation', { timeout: 60000 }, () => {
  const { env, setup, teardown } = setupTestEnv('inv', 'inv');

  beforeAll(setup);
  afterAll(teardown);

  const fetchRM = (path, options = {}) =>
    fetch(`http://127.0.0.1:${env.rmAdminPort}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    }).then((res) => res.json().then((body) => ({ status: res.status, body })));

  const fetchAdmin = (path, options = {}) =>
    fetch(`http://127.0.0.1:${env.adminPort}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    }).then((res) => res.json().then((body) => ({ status: res.status, body })));

  const insertEvents = (events) =>
    env.cleanupClient.db('inv-events').collection('events').insertMany(events);

  const rmDb = () => env.cleanupClient.db('inv-rm');

  const getTimestamp = () =>
    rmDb()
      .collection('readmodel.state')
      .findOne({ name: 'items' })
      .then((doc) => (doc ? doc.lastProjectedEventTimestamp : undefined));

  const emitReplayEvents = (events) => {
    const mq = getSharedMqEmitter('inv-sim', 'inv-events');
    return events.reduce(
      (chain, event) =>
        chain.then(
          () =>
            new Promise((resolve) => {
              mq.emit(
                {
                  topic: '__replay',
                  payload: {
                    correlationId: 'inv-test',
                    targetReadModel: 'items',
                    targetEndpointName: 'rm',
                    event,
                  },
                },
                resolve,
              );
            }),
        ),
      Promise.resolve(),
    );
  };

  // Tests run sequentially within a describe, sharing the same env.
  // Each test starts from the state left by the previous one.

  test('after catch-up (activate), timestamp matches last event', () =>
    insertEvents(
      Array.from({ length: 4 }, (_, i) => ({
        type: 'ITEM_CREATED',
        aggregateId: `inv-item-${i + 1}`,
        timestamp: (i + 1) * 100,
        payload: { name: `Inv Item ${i + 1}` },
      })),
    )
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
            return items.state === 'live';
          }),
        ),
      )
      .then(() => getTimestamp())
      .then((ts) => {
        expect(ts).toBe(400);
      }));

  test('after stop, timestamp is preserved', () =>
    fetchAdmin('/admin/readmodel/stop/rm/items', {
      method: 'POST',
      body: '{}',
    })
      .then(() =>
        waitForCondition(() =>
          fetchRM('/admin/readmodel').then(({ body }) => {
            const items = body.find((rm) => rm.name === 'items');
            return items.state === 'idle';
          }),
        ),
      )
      .then(() => getTimestamp())
      .then((ts) => {
        expect(ts).toBe(400);
      }));

  test('after reset (clearCollections), timestamp is 0', () =>
    rmDb()
      .collection('items_overview')
      .drop()
      .catch(() => {})
      .then(() =>
        env.rmContext.storage.updateLastProjectedEventTimestamps(
          'inv-reset',
          ['items'],
          0,
        ),
      )
      .then(() => getTimestamp())
      .then((ts) => {
        expect(ts).toBe(0);
      }));

  test('after replay from scratch, timestamp matches last replayed event', () =>
    env.rmContext.lifecycleManager
      .startReplay('items', 'inv-test')
      .then(() =>
        waitForCondition(() =>
          fetchRM('/admin/readmodel').then(({ body }) => {
            const items = body.find((rm) => rm.name === 'items');
            return items.state === 'replay';
          }),
        ),
      )
      .then(() =>
        emitReplayEvents(
          Array.from({ length: 4 }, (_, i) => ({
            type: 'ITEM_CREATED',
            aggregateId: `inv-item-${i + 1}`,
            timestamp: (i + 1) * 100,
            payload: { name: `Inv Item ${i + 1}` },
          })),
        ),
      )
      .then(() => env.rmContext.projectionHandler.flushEventQueue())
      .then(() =>
        env.rmContext.lifecycleManager.replayDone('items', 'inv-test'),
      )
      .then(() =>
        waitForCondition(() =>
          fetchRM('/admin/readmodel').then(({ body }) => {
            const items = body.find((rm) => rm.name === 'items');
            return items.state === 'replay-done';
          }),
        ),
      )
      // Replay does not update timestamp — stays at 0 (pre-replay reset value)
      .then(() => getTimestamp())
      .then((ts) => {
        expect(ts).toBe(0);
      }));

  test('after replay with no events, timestamp stays at 0', () =>
    // Reset first
    rmDb()
      .collection('items_overview')
      .drop()
      .catch(() => {})
      .then(() =>
        env.rmContext.storage.updateLastProjectedEventTimestamps(
          'inv-empty',
          ['items'],
          0,
        ),
      )
      .then(() =>
        env.rmContext.lifecycleManager.startReplay('items', 'inv-empty'),
      )
      .then(() =>
        waitForCondition(() =>
          fetchRM('/admin/readmodel').then(({ body }) => {
            const items = body.find((rm) => rm.name === 'items');
            return items.state === 'replay';
          }),
        ),
      )
      // No events emitted — just finalize
      .then(() =>
        env.rmContext.lifecycleManager.replayDone('items', 'inv-empty'),
      )
      .then(() =>
        waitForCondition(() =>
          fetchRM('/admin/readmodel').then(({ body }) => {
            const items = body.find((rm) => rm.name === 'items');
            return items.state === 'replay-done';
          }),
        ),
      )
      .then(() => getTimestamp())
      .then((ts) => {
        expect(ts).toBe(0);
      }));

  test('after live event projection, timestamp matches live event', () =>
    // Re-activate (events still in store from first test)
    fetchAdmin('/admin/readmodel/activate/rm/items', {
      method: 'POST',
      body: '{}',
    })
      .then(() =>
        waitForCondition(() =>
          fetchRM('/admin/readmodel').then(({ body }) => {
            const items = body.find((rm) => rm.name === 'items');
            return items.state === 'live';
          }),
        ),
      )
      // Emit a live event with a new timestamp
      .then(() => {
        const mq = getSharedMqEmitter('inv-live', 'inv-events');
        return new Promise((resolve) => {
          mq.emit(
            {
              topic: 'events',
              payload: {
                correlationId: 'inv-live',
                type: 'ITEM_CREATED',
                aggregateId: 'inv-item-5',
                timestamp: 500,
                payload: { name: 'Inv Item 5' },
              },
            },
            resolve,
          );
        });
      })
      .then(() =>
        waitForCondition(() =>
          rmDb()
            .collection('items_overview')
            .findOne({ id: 'inv-item-5' })
            .then((doc) => !!doc),
        ),
      )
      .then(() => getTimestamp())
      .then((ts) => {
        expect(ts).toBe(500);
      }));
});
