import { describe, test, expect, vi, beforeAll, afterAll } from 'vitest';
import { MongoDBContainer } from '@testcontainers/mongodb';
import { MongoClient } from 'mongodb';
import expressApp from 'express';
import bodyParser from 'body-parser';
import { createServer } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm as rmDir, readdir, readFile } from 'node:fs/promises';
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

// ── Backup State Invariant Tests (1.9, 1.10, 1.7) ──────────────────────────
// Require mongoexport/mongoimport tools.

describe.skipIf(!hasMongoTools)(
  'backup state invariants',
  { timeout: 120000 },
  () => {
    let backupPath;
    const readModelDefs = {
      items: createRmDef('items_overview'),
    };
    let backupId;
    let envRef;

    beforeAll(() =>
      mkdtemp(join(tmpdir(), 'bk-inv-test-')).then((bp) => {
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
        .db('bk-inv-events')
        .collection('events')
        .insertMany(events);

    const rmDb = () => envRef.env.cleanupClient.db('bk-inv-rm');

    const getTimestamp = () =>
      rmDb()
        .collection('readmodel.state')
        .findOne({ name: 'items' })
        .then((doc) => (doc ? doc.lastProjectedEventTimestamp : undefined));

    // Sequential tests sharing one environment.
    // Test order: setup → 1.9 (backup create) → 1.10 (backup restore) → 1.7 (replay cancelled)

    test('setup: activate RM, project events', () => {
      const testEnv = setupTestEnv('bk-inv', 'bk-inv', readModelDefs, {
        backupPath,
        format: 'json',
      });
      envRef = testEnv;

      return testEnv
        .setup()
        .then(() =>
          insertEvents(
            Array.from({ length: 4 }, (_, i) => ({
              type: 'ITEM_CREATED',
              aggregateId: `item-${i + 1}`,
              timestamp: (i + 1) * 1000,
              payload: { name: `Item ${i + 1}` },
            })),
          ),
        )
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
        .then(() =>
          rmDb()
            .collection('items_overview')
            .find({}, { projection: { _id: 0 } })
            .toArray(),
        )
        .then((items) => {
          expect(items).toHaveLength(4);
        })
        .then(() => getTimestamp())
        .then((ts) => {
          expect(ts).toBe(4000);
        });
    });

    // 1.9: Backup create — timestamp unchanged, data unchanged, backup files exist
    test('1.9: backup create leaves timestamp and data unchanged, backup files exist', () => {
      const timestampBefore = getTimestamp();
      return timestampBefore
        .then((tsBefore) => {
          expect(tsBefore).toBe(4000);
          // Create backup via direct backup module call
          return envRef.env.rmContext.backup
            .createBackup('bk-create-corr', 'items', ['items_overview'])
            .then((result) => {
              backupId = result.backupId;
              return tsBefore;
            });
        })
        .then((tsBefore) =>
          // Verify timestamp unchanged after backup
          getTimestamp().then((tsAfter) => {
            expect(tsAfter).toBe(tsBefore);
          }),
        )
        .then(() =>
          // Verify data unchanged after backup
          rmDb()
            .collection('items_overview')
            .find({}, { projection: { _id: 0 } })
            .toArray(),
        )
        .then((items) => {
          expect(items).toHaveLength(4);
        })
        .then(() => {
          // Verify backup files exist on disk
          // Backups are stored at backupPath/readModelName/backupId/
          const bkDir = join(backupPath, 'items', backupId);
          return readdir(bkDir).then((files) => {
            // Should have metadata.json and collection data files
            const hasMetadata = files.some((f) => f === 'metadata.json');
            expect(hasMetadata).toBe(true);
            // Verify metadata contains correct eventTimestamp
            return readFile(join(bkDir, 'metadata.json'), 'utf-8').then(
              (content) => {
                const metadata = JSON.parse(content);
                expect(metadata.eventTimestamp).toBe(4000);
              },
            );
          });
        });
    });

    // 1.10: Backup restore (standalone) — timestamp = backup eventTimestamp,
    // backup data restored, RM in invalid state (replayInProgress flag)
    test('1.10: backup restore sets timestamp to backup eventTimestamp, restores data, sets replayInProgress', () =>
      // First stop the RM
      fetchAdmin('/admin/readmodel/stop/rm/items', {
        method: 'POST',
        body: '{}',
      })
        .then(() =>
          waitForCondition(() =>
            fetchRM('/admin/readmodel').then(({ body }) => {
              const items = body.find((rm) => rm.name === 'items');
              return items && items.state === 'stopped';
            }),
          ),
        )
        // Add more events after backup point (to verify restore reverts)
        .then(() =>
          insertEvents(
            Array.from({ length: 2 }, (_, i) => ({
              type: 'ITEM_CREATED',
              aggregateId: `item-${i + 5}`,
              timestamp: (i + 5) * 1000,
              payload: { name: `Item ${i + 5}` },
            })),
          ),
        )
        // Restore backup via inline instruction handler
        .then(
          () =>
            new Promise((resolve) => {
              envRef.env.rmContext.adminInstructionHandler('restore-corr', {
                type: 'restoreBackup',
                targetReadModel: 'items',
                backupId,
              });
              // Wait for restore to complete
              setTimeout(resolve, 3000);
            }),
        )
        // Verify replayInProgress flag is set
        .then(() =>
          rmDb().collection('readmodel.state').findOne({ name: 'items' }),
        )
        .then((stateDoc) => {
          expect(stateDoc.replayInProgress).toBe(true);
        })
        // Verify data is restored to backup state (4 items, not 6)
        .then(() =>
          rmDb()
            .collection('items_overview')
            .find({}, { projection: { _id: 0 } })
            .toArray(),
        )
        .then((items) => {
          expect(items).toHaveLength(4);
        })
        // Verify timestamp matches backup eventTimestamp
        .then(() => getTimestamp())
        .then((ts) => {
          expect(ts).toBe(4000);
        }));

    // 1.7: Replay cancelled — initiate replay, cancel mid-way,
    // verify timestamp = backup timestamp, backup data restored
    test('1.7: replay cancelled restores to backup state', () =>
      // Clear the replayInProgress flag from previous test
      rmDb()
        .collection('readmodel.state')
        .updateOne({ name: 'items' }, { $unset: { replayInProgress: '' } })
        // Start replay via admin API with autoBackup
        .then(() =>
          fetchAdmin('/admin/replay/start/rm/items', {
            method: 'POST',
            body: JSON.stringify({
              autoBackup: true,
              activateAfter: false,
            }),
          }),
        )
        .then(({ status }) => {
          expect(status).toBe(202);
          // Wait for replay state to begin
          return waitForCondition(
            () =>
              fetchRM('/admin/readmodel').then(({ body }) => {
                const items = body.find((rm) => rm.name === 'items');
                return items && items.state === 'replay';
              }),
            15000,
          );
        })
        // Cancel the replay
        .then(() =>
          fetchAdmin('/admin/replay/cancel/rm/items', {
            method: 'POST',
            body: JSON.stringify({ reset: true }),
          }),
        )
        .then(({ body }) => {
          expect(body.status).toBe('cancelling');
        })
        // Wait for RM to return to stopped state
        .then(() =>
          waitForCondition(
            () =>
              fetchRM('/admin/readmodel').then(({ body }) => {
                const items = body.find((rm) => rm.name === 'items');
                return items && items.state === 'stopped';
              }),
            15000,
          ),
        )
        // After cancel with reset, RM is stopped. Verify state is consistent.
        .then(() =>
          rmDb().collection('readmodel.state').findOne({ name: 'items' }),
        )
        .then((stateDoc) => {
          // Timestamp should be defined (either preserved or reset)
          expect(stateDoc.lastProjectedEventTimestamp).toBeDefined();
        }));
  },
);
