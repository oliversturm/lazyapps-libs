import { describe, test, expect, vi, beforeAll, afterAll } from 'vitest';
import { MongoDBContainer } from '@testcontainers/mongodb';
import { MongoClient } from 'mongodb';
import expressApp from 'express';
import bodyParser from 'body-parser';
import { createServer } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm as rmDir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
const { backup: backupFactory } =
  await import('@lazyapps/readmodelstorage-mongodb/backup.js');

const hasMongoTools = (() => {
  try {
    execFileSync('mongoexport', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// Create a read model definition that projects ITEM_CREATED events
// using upsert for idempotency (avoids duplicates from replay+catchup overlap)
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

// Admin instruction handler for RM side — includes persistTimestamp for T=0
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
      case 'createBackup':
        if (instruction.targetReadModel && context.backup) {
          const rmDef = context.readModels[instruction.targetReadModel];
          const colNames = rmDef?.collections || [instruction.targetReadModel];
          context.backup
            .createBackup(correlationId, instruction.targetReadModel, colNames)
            .then((result) => {
              if (context.statusTracker) {
                context.statusTracker.updateStatus(
                  instruction.targetReadModel,
                  {
                    backupProgress: {
                      state: 'idle',
                      backupId: result.backupId,
                    },
                  },
                );
                context.statusTracker.immediatePush(
                  instruction.targetReadModel,
                );
              }
            })
            .catch(() => {
              if (context.statusTracker) {
                context.statusTracker.updateStatus(
                  instruction.targetReadModel,
                  {
                    backupProgress: { state: 'idle' },
                  },
                );
                context.statusTracker.immediatePush(
                  instruction.targetReadModel,
                );
              }
            });
        }
        break;
      case 'restoreBackup':
        if (instruction.targetReadModel && context.backup) {
          // Set 'restoring' status BEFORE starting — matches real handler
          if (context.statusTracker) {
            context.statusTracker.updateStatus(instruction.targetReadModel, {
              backupProgress: {
                state: 'restoring',
                backupId: instruction.backupId,
              },
            });
            context.statusTracker.immediatePush(instruction.targetReadModel);
          }
          context.storage
            .perRequest(correlationId)
            .updateOne(
              'readmodel.state',
              { name: instruction.targetReadModel },
              { $set: { replayInProgress: true } },
            )
            .then(() =>
              context.backup.restoreBackup(
                correlationId,
                instruction.targetReadModel,
                instruction.backupId,
              ),
            )
            .then(() => {
              if (context.statusTracker) {
                context.statusTracker.updateStatus(
                  instruction.targetReadModel,
                  {
                    backupProgress: {
                      state: 'idle',
                      backupId: instruction.backupId,
                    },
                  },
                );
                context.statusTracker.immediatePush(
                  instruction.targetReadModel,
                );
              }
            })
            .catch(() => {
              if (context.statusTracker) {
                context.statusTracker.updateStatus(
                  instruction.targetReadModel,
                  {
                    backupProgress: { state: 'idle' },
                  },
                );
                context.statusTracker.immediatePush(
                  instruction.targetReadModel,
                );
              }
            });
        }
        break;
      case 'persistTimestamp':
        if (instruction.targetReadModel && instruction.timestamp != null) {
          context.storage
            .updateLastProjectedEventTimestamps(
              correlationId,
              [instruction.targetReadModel],
              instruction.timestamp,
            )
            .then(() => {
              if (context.readModels[instruction.targetReadModel]) {
                context.readModels[
                  instruction.targetReadModel
                ].lastProjectedEventTimestamp = instruction.timestamp;
              }
              if (context.statusTracker) {
                context.statusTracker.immediatePush(
                  instruction.targetReadModel,
                );
              }
            })
            .catch(() => {});
        }
        break;
    }
  };
};

// Helper to set up a full test environment with multiple read models
// backupConfig: optional { backupPath, format } to wire backup module
const setupTestEnv = (mqPrefix, dbPrefix, readModelDefs, backupConfig) => {
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

        const contextConfig = {
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
        };
        if (backupConfig) {
          contextConfig.backup = backupFactory({
            backupPath: backupConfig.backupPath,
            format: backupConfig.format || 'json',
          });
        }

        return initializeContext(
          { serviceId: `${dbPrefix}-RM` },
          contextConfig,
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

// ── T=0 Fresh RM Tests ──────────────────────────────────────────────────
// Each T=0 option uses a separate read model name to avoid resets between tests.
// All RMs project the same ITEM_CREATED events to their own collections.

describe(
  'T=0 fresh RM detection and replay options',
  { timeout: 60000 },
  () => {
    const readModelDefs = {
      t0detect: createRmDef('t0detect_col'),
      t0opt1: createRmDef('t0opt1_col'),
      t0opt2: createRmDef('t0opt2_col'),
      t0opt3: createRmDef('t0opt3_col'),
      t0opt2noact: createRmDef('t0opt2noact_col'),
    };
    const { env, setup, teardown } = setupTestEnv(
      't0-fresh',
      't0-fresh',
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
        .db('t0-fresh-events')
        .collection('events')
        .insertMany(events);

    const rmDb = () => env.cleanupClient.db('t0-fresh-rm');

    // Seed events once — all tests share the same event store
    test('preflight returns tzero=true for fresh RM with no projected events', () =>
      insertEvents(
        Array.from({ length: 5 }, (_, i) => ({
          type: 'ITEM_CREATED',
          aggregateId: `item-${i + 1}`,
          timestamp: (i + 1) * 1000,
          payload: { name: `Item ${i + 1}` },
        })),
      )
        .then(() =>
          waitForCondition(() =>
            fetchAdmin('/admin/readmodel/status').then(
              ({ body }) => body.length > 0,
            ),
          ),
        )
        .then(() => fetchAdmin('/admin/replay/preflight/rm/t0detect'))
        .then(({ body }) => {
          expect(body.found).toBe(true);
          expect(body.tzero).toBe(true);
          expect(body.lastProjectedEventTimestamp).toBe(0);
          expect(body.lastEventStoreTimestamp).toBe(5000);
        }));

    // T=0 Option 1 — replayToCurrentTime
    test('replayToCurrentTime replays all events, sets timestamp to last event store ts', () =>
      fetchAdmin('/admin/replay/start/rm/t0opt1', {
        method: 'POST',
        body: JSON.stringify({
          t0Option: 'replayToCurrentTime',
          activateAfter: true,
        }),
      })
        .then(({ status }) => {
          expect(status).toBe(202);
          return waitForCondition(
            () =>
              fetchRM('/admin/readmodel').then(({ body }) => {
                const rm = body.find((r) => r.name === 't0opt1');
                return rm && rm.state === 'live';
              }),
            30000,
          );
        })
        .then(() =>
          rmDb()
            .collection('t0opt1_col')
            .find({}, { projection: { _id: 0 } })
            .toArray(),
        )
        .then((items) => {
          expect(items).toHaveLength(5);
        })
        .then(() =>
          rmDb().collection('readmodel.state').findOne({ name: 't0opt1' }),
        )
        .then((stateDoc) => {
          expect(stateDoc.lastProjectedEventTimestamp).toBe(5000);
        }));

    // T=0 Option 2 — skipReplayCatchUpOnly (uses fresh t0opt2 RM)
    test('skipReplayCatchUpOnly skips replay and goes straight to catch-up', () =>
      fetchAdmin('/admin/replay/start/rm/t0opt2', {
        method: 'POST',
        body: JSON.stringify({
          t0Option: 'skipReplayCatchUpOnly',
          activateAfter: true,
        }),
      })
        .then(({ status }) => {
          expect(status).toBe(202);
          return waitForCondition(
            () =>
              fetchRM('/admin/readmodel').then(({ body }) => {
                const rm = body.find((r) => r.name === 't0opt2');
                return rm && rm.state === 'live';
              }),
            30000,
          );
        })
        .then(() =>
          rmDb()
            .collection('t0opt2_col')
            .find({}, { projection: { _id: 0 } })
            .toArray(),
        )
        .then((items) => {
          // All 5 events caught up (via catch-up from ts=0, not replay)
          expect(items).toHaveLength(5);
        })
        .then(() =>
          rmDb().collection('readmodel.state').findOne({ name: 't0opt2' }),
        )
        .then((stateDoc) => {
          expect(stateDoc.lastProjectedEventTimestamp).toBe(5000);
        }));

    // T=0 Option 3 — customBoundary (uses fresh t0opt3 RM)
    test('customBoundary replays to the specified timestamp then catches up', () =>
      fetchAdmin('/admin/replay/start/rm/t0opt3', {
        method: 'POST',
        body: JSON.stringify({
          t0Option: 'customBoundary',
          customTimestamp: 3000,
          activateAfter: true,
        }),
      })
        .then(({ status }) => {
          expect(status).toBe(202);
          return waitForCondition(
            () =>
              fetchRM('/admin/readmodel').then(({ body }) => {
                const rm = body.find((r) => r.name === 't0opt3');
                return rm && rm.state === 'live';
              }),
            30000,
          );
        })
        .then(() =>
          rmDb()
            .collection('t0opt3_col')
            .find({}, { projection: { _id: 0 } })
            .toArray(),
        )
        .then((items) => {
          // All 5: 3 via replay to ts=3000, 2 more via catch-up from 3000
          expect(items).toHaveLength(5);
        })
        .then(() =>
          rmDb().collection('readmodel.state').findOne({ name: 't0opt3' }),
        )
        .then((stateDoc) => {
          expect(stateDoc.lastProjectedEventTimestamp).toBe(5000);
        }));

    // T=0 Option 2 with activateAfter=false — skipReplayCatchUpOnly
    // This is ineffectual: skip replay, no catch-up, RM stays stopped with no data.
    test('skipReplayCatchUpOnly with activateAfter=false leaves RM stopped with no data', () =>
      fetchAdmin('/admin/replay/start/rm/t0opt2noact', {
        method: 'POST',
        body: JSON.stringify({
          t0Option: 'skipReplayCatchUpOnly',
          activateAfter: false,
        }),
      })
        .then(({ status }) => {
          expect(status).toBe(202);
          // The orchestrator will: stop → reset → return stopped with warning
          // (no replay, no catch-up, no activation).
          // Give it a moment to complete.
          return new Promise((r) => setTimeout(r, 2000));
        })
        // Verify RM is stopped (not live)
        .then(() =>
          fetchRM('/admin/readmodel').then(({ body }) => {
            const rm = body.find((r) => r.name === 't0opt2noact');
            expect(rm.state).toBe('idle');
          }),
        )
        // Verify no data was projected (skip replay + no activation = no data)
        .then(() =>
          rmDb()
            .collection('t0opt2noact_col')
            .countDocuments()
            .then((count) => {
              expect(count).toBe(0);
            }),
        )
        // Verify timestamp is still 0 (T=0, never changed)
        .then(() =>
          rmDb().collection('readmodel.state').findOne({ name: 't0opt2noact' }),
        )
        .then((stateDoc) => {
          // Timestamp remains 0 since nothing happened
          expect(stateDoc?.lastProjectedEventTimestamp || 0).toBe(0);
        }));
  },
);

// ── Non-T=0 Control Test ────────────────────────────────────────────────

describe(
  'non-T=0 control: RM with existing timestamp',
  { timeout: 60000 },
  () => {
    const readModelDefs = {
      items: createRmDef('items_overview'),
    };
    const { env, setup, teardown } = setupTestEnv(
      't0-ctrl',
      't0-ctrl',
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
        .db('t0-ctrl-events')
        .collection('events')
        .insertMany(events);

    const rmDb = () => env.cleanupClient.db('t0-ctrl-rm');

    test('preflight returns tzero=false for RM with existing timestamp', () =>
      insertEvents(
        Array.from({ length: 3 }, (_, i) => ({
          type: 'ITEM_CREATED',
          aggregateId: `ctrl-item-${i + 1}`,
          timestamp: (i + 1) * 100,
          payload: { name: `Ctrl Item ${i + 1}` },
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
              return items && items.state === 'live';
            }),
          ),
        )
        .then(() =>
          rmDb()
            .collection('items_overview')
            .find({}, { projection: { _id: 0 } })
            .toArray(),
        )
        .then((items) => {
          expect(items).toHaveLength(3);
        })
        .then(() => fetchAdmin('/admin/replay/preflight/rm/items'))
        .then(({ body }) => {
          expect(body.found).toBe(true);
          expect(body.tzero).toBe(false);
          expect(body.lastProjectedEventTimestamp).toBe(300);
        }));

    test('normal replay works for non-T=0 RM', () =>
      insertEvents(
        Array.from({ length: 2 }, (_, i) => ({
          type: 'ITEM_CREATED',
          aggregateId: `ctrl-item-${i + 4}`,
          timestamp: (i + 4) * 100,
          payload: { name: `Ctrl Item ${i + 4}` },
        })),
      )
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
                return items && items.state === 'live';
              }),
            30000,
          );
        })
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
          expect(stateDoc.lastProjectedEventTimestamp).toBe(500);
        }));
  },
);

// ── Backup T=0 Tests ────────────────────────────────────────────────────
// Tests the backupReplayOrchestration with T=0 options:
//   acceptLastEvent, acceptBackupTimestamp, customBoundary
// Requires mongoexport/mongoimport tools for JSON-format backup.

describe.skipIf(!hasMongoTools)(
  'backup T=0 replay options',
  { timeout: 120000 },
  () => {
    let backupPath;
    const readModelDefs = {
      bkOpt1: createRmDef('bkopt1_col'),
      bkOpt2: createRmDef('bkopt2_col'),
      bkOpt3: createRmDef('bkopt3_col'),
    };

    // Store backup IDs from creation phase
    const backupIds = {};

    let envRef;

    beforeAll(() =>
      mkdtemp(join(tmpdir(), 'bk-t0-test-')).then((bp) => {
        backupPath = bp;
      }),
    );

    afterAll(() =>
      Promise.resolve()
        .then(() => (envRef ? envRef.teardown() : undefined))
        .then(() =>
          backupPath
            ? rmDir(backupPath, { recursive: true, force: true })
            : undefined,
        ),
    );

    const fetchAdmin = (path, options = {}) =>
      fetch(`http://127.0.0.1:${envRef.env.adminPort}${path}`, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
      }).then((res) =>
        res.json().then((body) => ({ status: res.status, body })),
      );

    const fetchRM = (path) =>
      fetch(`http://127.0.0.1:${envRef.env.rmAdminPort}${path}`, {
        headers: { 'Content-Type': 'application/json' },
      }).then((res) =>
        res.json().then((body) => ({ status: res.status, body })),
      );

    const insertEvents = (events) =>
      envRef.env.cleanupClient
        .db('bk-t0-events')
        .collection('events')
        .insertMany(events);

    const rmDb = () => envRef.env.cleanupClient.db('bk-t0-rm');

    // Setup: create environment, activate RMs, project events, create backups
    test('setup: activate RMs, project events, create backups', () => {
      const testEnv = setupTestEnv('bk-t0', 'bk-t0', readModelDefs, {
        backupPath,
        format: 'json',
      });
      envRef = testEnv;

      return testEnv
        .setup()
        .then(() =>
          // Insert first 3 events
          insertEvents(
            Array.from({ length: 3 }, (_, i) => ({
              type: 'ITEM_CREATED',
              aggregateId: `bk-item-${i + 1}`,
              timestamp: (i + 1) * 1000,
              payload: { name: `BK Item ${i + 1}` },
            })),
          ),
        )
        .then(() =>
          // Wait for admin to have RM status
          waitForCondition(() =>
            fetchAdmin('/admin/readmodel/status').then(
              ({ body }) => body.length > 0,
            ),
          ),
        )
        .then(() =>
          // Activate all 3 RMs in sequence
          ['bkOpt1', 'bkOpt2', 'bkOpt3'].reduce(
            (chain, rm) =>
              chain
                .then(() =>
                  fetchAdmin(`/admin/readmodel/activate/rm/${rm}`, {
                    method: 'POST',
                    body: '{}',
                  }),
                )
                .then(() =>
                  waitForCondition(
                    () =>
                      fetchRM('/admin/readmodel').then(({ body }) => {
                        const r = body.find((x) => x.name === rm);
                        return r && r.state === 'live';
                      }),
                    15000,
                  ),
                ),
            Promise.resolve(),
          ),
        )
        .then(() =>
          // Verify all 3 RMs have projected the 3 events
          Promise.all(
            ['bkopt1_col', 'bkopt2_col', 'bkopt3_col'].map((col) =>
              rmDb().collection(col).countDocuments(),
            ),
          ).then((counts) => {
            counts.forEach((c) => expect(c).toBe(3));
          }),
        )
        .then(() =>
          // Create backups for each RM via direct backup module call
          ['bkOpt1', 'bkOpt2', 'bkOpt3'].reduce(
            (chain, rm) =>
              chain.then(() => {
                const rmDef = readModelDefs[rm];
                return envRef.env.rmContext.backup
                  .createBackup('bk-corr', rm, rmDef.collections)
                  .then((result) => {
                    backupIds[rm] = result.backupId;
                  });
              }),
            Promise.resolve(),
          ),
        )
        .then(() =>
          // Stop all RMs
          ['bkOpt1', 'bkOpt2', 'bkOpt3'].reduce(
            (chain, rm) =>
              chain
                .then(() =>
                  fetchAdmin(`/admin/readmodel/stop/rm/${rm}`, {
                    method: 'POST',
                    body: '{}',
                  }),
                )
                .then(() =>
                  waitForCondition(() =>
                    fetchRM('/admin/readmodel').then(({ body }) => {
                      const r = body.find((x) => x.name === rm);
                      return r && r.state === 'idle';
                    }),
                  ),
                ),
            Promise.resolve(),
          ),
        )
        .then(() =>
          // Insert 2 more events (ts 4000, 5000) after backup
          insertEvents(
            Array.from({ length: 2 }, (_, i) => ({
              type: 'ITEM_CREATED',
              aggregateId: `bk-item-${i + 4}`,
              timestamp: (i + 4) * 1000,
              payload: { name: `BK Item ${i + 4}` },
            })),
          ),
        );
    });

    // Backup T=0 Option 1 — acceptLastEvent
    // Restores backup (ts=3000), replays from 3000 to last event store ts (5000),
    // then activates with catch-up
    test('acceptLastEvent: restore backup, replay to last event store ts, activate', () =>
      fetchAdmin('/admin/replay/start/rm/bkOpt1', {
        method: 'POST',
        body: JSON.stringify({
          backupId: backupIds.bkOpt1,
          t0Option: 'acceptLastEvent',
          activateAfter: true,
        }),
      })
        .then(({ status }) => {
          expect(status).toBe(202);
          return waitForCondition(
            () =>
              fetchRM('/admin/readmodel').then(({ body }) => {
                const rm = body.find((r) => r.name === 'bkOpt1');
                return rm && rm.state === 'live';
              }),
            30000,
          );
        })
        .then(() =>
          waitForCondition(
            () =>
              rmDb()
                .collection('bkopt1_col')
                .countDocuments()
                .then((c) => c === 5),
            5000,
          ),
        )
        .then(() =>
          rmDb()
            .collection('bkopt1_col')
            .find({}, { projection: { _id: 0 } })
            .toArray(),
        )
        .then((items) => {
          expect(items).toHaveLength(5);
        })
        .then(() =>
          rmDb().collection('readmodel.state').findOne({ name: 'bkOpt1' }),
        )
        .then((stateDoc) => {
          expect(stateDoc.lastProjectedEventTimestamp).toBe(5000);
        }));

    // Backup T=0 Option 2 — acceptBackupTimestamp
    // Restores backup (ts=3000), persists backup timestamp, activates with
    // catch-up from 3000
    test('acceptBackupTimestamp: restore backup, catch up from backup ts', () =>
      fetchAdmin('/admin/replay/start/rm/bkOpt2', {
        method: 'POST',
        body: JSON.stringify({
          backupId: backupIds.bkOpt2,
          t0Option: 'acceptBackupTimestamp',
          activateAfter: true,
        }),
      })
        .then(({ status }) => {
          expect(status).toBe(202);
          return waitForCondition(
            () =>
              fetchRM('/admin/readmodel').then(({ body }) => {
                const rm = body.find((r) => r.name === 'bkOpt2');
                return rm && rm.state === 'live';
              }),
            30000,
          );
        })
        .then(() =>
          // Wait for all items to be projected — catch-up events may still
          // be in-flight when the RM transitions to 'live'
          waitForCondition(
            () =>
              rmDb()
                .collection('bkopt2_col')
                .countDocuments()
                .then((c) => c === 5),
            5000,
          ),
        )
        .then(() =>
          rmDb()
            .collection('bkopt2_col')
            .find({}, { projection: { _id: 0 } })
            .toArray(),
        )
        .then((items) => {
          // 3 from backup + 2 from catch-up = 5
          expect(items).toHaveLength(5);
        })
        .then(() =>
          rmDb().collection('readmodel.state').findOne({ name: 'bkOpt2' }),
        )
        .then((stateDoc) => {
          expect(stateDoc.lastProjectedEventTimestamp).toBe(5000);
        }));

    // Backup T=0 Option 3 — customBoundary
    // Restores backup (ts=3000), replays from 3000 to 4000, then activates
    // with catch-up from 4000
    test('customBoundary: restore backup, replay to custom ts, catch up rest', () =>
      fetchAdmin('/admin/replay/start/rm/bkOpt3', {
        method: 'POST',
        body: JSON.stringify({
          backupId: backupIds.bkOpt3,
          t0Option: 'customBoundary',
          customTimestamp: 4000,
          activateAfter: true,
        }),
      })
        .then(({ status }) => {
          expect(status).toBe(202);
          return waitForCondition(
            () =>
              fetchRM('/admin/readmodel').then(({ body }) => {
                const rm = body.find((r) => r.name === 'bkOpt3');
                return rm && rm.state === 'live';
              }),
            30000,
          );
        })
        .then(() =>
          waitForCondition(
            () =>
              rmDb()
                .collection('bkopt3_col')
                .countDocuments()
                .then((c) => c === 5),
            5000,
          ),
        )
        .then(() =>
          rmDb()
            .collection('bkopt3_col')
            .find({}, { projection: { _id: 0 } })
            .toArray(),
        )
        .then((items) => {
          // 3 from backup, 1 from replay (ts=4000), 1 from catch-up (ts=5000) = 5
          expect(items).toHaveLength(5);
        })
        .then(() =>
          rmDb().collection('readmodel.state').findOne({ name: 'bkOpt3' }),
        )
        .then((stateDoc) => {
          expect(stateDoc.lastProjectedEventTimestamp).toBe(5000);
        }));
  },
);
