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

const createRmDef = (collectionName) => ({
  projections: {
    ITEM_CREATED: ({ storage }, event) =>
      storage.updateOne(
        collectionName,
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
      storage.find(collectionName, {}).project({ _id: 0 }).toArray(),
  },
  collections: [collectionName],
  replayRelevantEvents: ['ITEM_CREATED'],
});

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

const setupTestEnv = (mqPrefix, dbPrefix, readModelDefs) => {
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
            readModels: readModelDefs,
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

// ── 1.8: Replay with activateAfter=false ────────────────────────────────
// Replay completes, RM stays stopped (no auto-activation), data present,
// timestamp correct.

describe('replay with activateAfter=false', { timeout: 60000 }, () => {
  const readModelDefs = {
    items: createRmDef('items_overview'),
  };
  const { env, setup, teardown } = setupTestEnv(
    'rpl-noact',
    'rpl-noact',
    readModelDefs,
  );

  beforeAll(setup);
  afterAll(teardown);

  const fetchAdmin = (path, options = {}) =>
    fetch(`http://127.0.0.1:${env.adminPort}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    }).then((res) => res.json().then((body) => ({ status: res.status, body })));

  const fetchRM = (path) =>
    fetch(`http://127.0.0.1:${env.rmAdminPort}${path}`, {
      headers: { 'Content-Type': 'application/json' },
    }).then((res) => res.json().then((body) => ({ status: res.status, body })));

  const insertEvents = (events) =>
    env.cleanupClient
      .db('rpl-noact-events')
      .collection('events')
      .insertMany(events);

  const rmDb = () => env.cleanupClient.db('rpl-noact-rm');

  test('replay with activateAfter=false: RM stays stopped, data present, timestamp correct', () =>
    // Insert events
    insertEvents(
      Array.from({ length: 5 }, (_, i) => ({
        type: 'ITEM_CREATED',
        aggregateId: `item-${i + 1}`,
        timestamp: (i + 1) * 1000,
        payload: { name: `Item ${i + 1}` },
      })),
    )
      // Activate → live (to establish a non-zero timestamp)
      .then(() =>
        waitForCondition(() =>
          fetchAdmin('/admin/readmodel/status').then(
            ({ body }) => body.length > 0,
          ),
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
            return items && items.state === 'live';
          }),
        ),
      )
      // Verify 5 items and timestamp=5000
      .then(() =>
        rmDb()
          .collection('items_overview')
          .find({}, { projection: { _id: 0 } })
          .toArray(),
      )
      .then((items) => {
        expect(items).toHaveLength(5);
      })
      .then(() =>
        rmDb().collection('readmodel.state').findOne({ name: 'items' }),
      )
      .then((stateDoc) => {
        expect(stateDoc.lastProjectedEventTimestamp).toBe(5000);
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
            return items && items.state === 'idle';
          }),
        ),
      )
      // Reset data before replay so we can detect when replay re-projects it
      .then(() =>
        rmDb()
          .collection('items_overview')
          .drop()
          .catch(() => {}),
      )
      // Start replay with activateAfter=false
      .then(() =>
        fetchAdmin('/admin/replay/start/rm/items', {
          method: 'POST',
          body: JSON.stringify({ activateAfter: false }),
        }),
      )
      .then(({ status }) => {
        expect(status).toBe(202);
        // The orchestrator resets, replays, sends replayDone, then stops.
        // Wait for the data to be re-projected (proves replay ran).
        return waitForCondition(
          () =>
            rmDb()
              .collection('items_overview')
              .countDocuments()
              .then((c) => c === 5),
          30000,
        );
      })
      // Give the orchestrator a moment to finish the replayDone step
      .then(() => new Promise((r) => setTimeout(r, 2000)))
      // Verify RM is stopped (NOT live — activateAfter=false)
      .then(() => fetchRM('/admin/readmodel'))
      .then(({ body }) => {
        const items = body.find((rm) => rm.name === 'items');
        expect(items.state).toBe('stopped');
      })
      // Verify data was replayed (items present)
      .then(() =>
        rmDb()
          .collection('items_overview')
          .find({}, { projection: { _id: 0 } })
          .toArray(),
      )
      .then((items) => {
        expect(items).toHaveLength(5);
      })
      // Verify timestamp — replay does not update per-event, but the
      // orchestrator resets to 0 before replay, so stays at 0
      .then(() =>
        rmDb().collection('readmodel.state').findOne({ name: 'items' }),
      )
      .then((stateDoc) => {
        // In non-T=0 replay, the orchestrator preserves the existing
        // timestamp (5000). Replay does not update it per-event.
        // The orchestrator reset the data collections but not the timestamp.
        expect(stateDoc.lastProjectedEventTimestamp).toBe(5000);
      })
      // 3.2: After replay with activateAfter=false, manually activate
      // Insert new events after the replay so catch-up has work to do
      .then(() =>
        env.cleanupClient
          .db('rpl-noact-events')
          .collection('events')
          .insertMany(
            Array.from({ length: 2 }, (_, i) => ({
              type: 'ITEM_CREATED',
              aggregateId: `item-${i + 6}`,
              timestamp: (i + 6) * 1000,
              payload: { name: `Item ${i + 6}` },
            })),
          ),
      )
      // Manually activate via admin API
      .then(() =>
        fetchAdmin('/admin/readmodel/activate/rm/items', {
          method: 'POST',
          body: '{}',
        }),
      )
      .then(() =>
        waitForCondition(
          () =>
            fetchRM('/admin/readmodel').then(({ body }) => {
              const items = body.find((rm) => rm.name === 'items');
              return items && items.state === 'live';
            }),
          30000,
        ),
      )
      // Verify all items present (5 from replay + 2 new via catch-up = 7)
      .then(() =>
        waitForCondition(
          () =>
            rmDb()
              .collection('items_overview')
              .countDocuments()
              .then((c) => c === 7),
          5000,
        ),
      )
      .then(() =>
        rmDb()
          .collection('items_overview')
          .find({}, { projection: { _id: 0 } })
          .toArray(),
      )
      .then((items) => {
        expect(items).toHaveLength(7);
      })
      // Verify timestamp updated to include catch-up events
      .then(() =>
        rmDb().collection('readmodel.state').findOne({ name: 'items' }),
      )
      .then((stateDoc) => {
        expect(stateDoc.lastProjectedEventTimestamp).toBe(7000);
      }));
});
