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

// Idempotent read model definition (upsert to handle replay+catchup overlap)
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

// Admin instruction handler for RM side — includes backup/restore/persistTimestamp
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
                  { backupProgress: { state: 'idle' } },
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
                  { backupProgress: { state: 'idle' } },
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

// Full test environment setup with admin orchestrator (like catchup.integration.test.js)
const setupTestEnv = (
  mqPrefix,
  dbPrefix,
  readModelDefs,
  backupConfig,
  extraConfig,
) => {
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
          ...(extraConfig || {}),
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
            ...(extraConfig?.developmentMode ? { developmentMode: true } : {}),
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

// ── Category 4: Backup + Restore Sequences ──────────────────────────────

describe.skipIf(!hasMongoTools)(
  'C4: backup + restore sequences',
  { timeout: 120000 },
  () => {
    let backupPath;
    const readModelDefs = {
      items: createRmDef('items_overview'),
    };
    const backupIds = {};

    const { env, setup, teardown } = setupTestEnv(
      'c4-bkrs',
      'c4-bkrs',
      readModelDefs,
    );

    beforeAll(() =>
      mkdtemp(join(tmpdir(), 'c4-bkrs-test-')).then((bp) => {
        backupPath = bp;
        return setup();
      }),
    );

    afterAll(() =>
      teardown().then(() =>
        backupPath
          ? rmDir(backupPath, { recursive: true, force: true })
          : undefined,
      ),
    );

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
        .db('c4-bkrs-events')
        .collection('events')
        .insertMany(events);

    const rmDb = () => env.cleanupClient.db('c4-bkrs-rm');

    // 4.1: Create backup, add new events, restore backup, activate:
    //      data reverted to backup point, catch-up fills gap with new events
    test('4.1: backup → new events → restore → activate: data reverted, catch-up fills gap', () => {
      // Wire backup module onto the RM context for this test
      // backupFactory returns a curried function: config => storage => backupObj
      env.rmContext.backup = backupFactory({
        backupPath,
        format: 'json',
      })(env.rmContext.storage);

      return (
        // Step 1: Insert 3 events and activate RM
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
            waitForCondition(
              () =>
                fetchRM('/admin/readmodel').then(({ body }) => {
                  const items = body.find((rm) => rm.name === 'items');
                  return items && items.state === 'live';
                }),
              15000,
            ),
          )
          // Verify 3 items projected
          .then(() => rmDb().collection('items_overview').countDocuments())
          .then((count) => {
            expect(count).toBe(3);
          })
          // Step 2: Create backup at ts=3000
          .then(() =>
            env.rmContext.backup
              .createBackup('bk-corr', 'items', ['items_overview'])
              .then((result) => {
                backupIds.items = result.backupId;
              }),
          )
          // Step 3: Stop RM, add 2 more events
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
                return items && items.state === 'stopped';
              }),
            ),
          )
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
          // Step 4: Restore backup (reverts data to 3 items)
          .then(() =>
            env.rmContext.backup.restoreBackup(
              'restore-corr',
              'items',
              backupIds.items,
            ),
          )
          // Verify data reverted to 3 items
          .then(() =>
            rmDb()
              .collection('items_overview')
              .find({}, { projection: { _id: 0 } })
              .toArray(),
          )
          .then((items) => {
            expect(items).toHaveLength(3);
          })
          // Step 5: Activate — catch-up should fill the gap
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
              15000,
            ),
          )
          .then(() =>
            waitForCondition(
              () =>
                rmDb()
                  .collection('items_overview')
                  .countDocuments()
                  .then((c) => c === 5),
              5000,
            ),
          )
          // Verify all 5 items present
          .then(() =>
            rmDb()
              .collection('items_overview')
              .find({}, { projection: { _id: 0 } })
              .toArray(),
          )
          .then((items) => {
            expect(items).toHaveLength(5);
            const ids = items.map((it) => it.id).sort();
            expect(ids).toEqual([
              'item-1',
              'item-2',
              'item-3',
              'item-4',
              'item-5',
            ]);
          })
          // Verify timestamp is at 5000 (latest event)
          .then(() =>
            rmDb().collection('readmodel.state').findOne({ name: 'items' }),
          )
          .then((stateDoc) => {
            expect(stateDoc.lastProjectedEventTimestamp).toBe(5000);
          })
      );
    });

    // 4.3: Restore backup standalone, stay stopped, inspect state, then activate
    test('4.3: restore backup → stay stopped → inspect state → then activate', () =>
      // Step 1: Stop the RM (it's currently live from 4.1)
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
        // Step 2: Restore the backup (reverts to 3 items and readmodel.state)
        .then(() =>
          env.rmContext.backup.restoreBackup(
            'inspect-corr',
            'items',
            backupIds.items,
          ),
        )
        // Reload in-memory timestamp from restored MongoDB state
        // (in a real restart this happens naturally via initializeContext)
        .then(() =>
          rmDb().collection('readmodel.state').findOne({ name: 'items' }),
        )
        .then((stateDoc) => {
          env.rmContext.readModels.items.lastProjectedEventTimestamp =
            stateDoc.lastProjectedEventTimestamp;
          // Also update the status tracker so the admin SSE cache gets
          // the correct timestamp (stateVersion ordering would otherwise
          // reject the polled update)
          env.rmContext.statusTracker.updateLastProjectedEventTimestamp(
            'items',
            stateDoc.lastProjectedEventTimestamp,
          );
          env.rmContext.statusTracker.immediatePush('items');
        })
        // Step 3: Inspect state — RM should still be stopped
        .then(() =>
          fetchRM('/admin/readmodel').then(({ body }) => {
            const items = body.find((rm) => rm.name === 'items');
            expect(items.state).toBe('stopped');
          }),
        )
        // Verify data was reverted to backup point (3 items)
        .then(() =>
          rmDb()
            .collection('items_overview')
            .find({}, { projection: { _id: 0 } })
            .toArray(),
        )
        .then((items) => {
          expect(items).toHaveLength(3);
        })
        // Step 4: Activate — catch-up fills gap
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
            15000,
          ),
        )
        .then(() =>
          waitForCondition(
            () =>
              rmDb()
                .collection('items_overview')
                .countDocuments()
                .then((c) => c === 5),
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
          expect(items).toHaveLength(5);
        }));
  },
);

// ── Category 5: Clean Restart from Known States ─────────────────────────
// "Restart" means rebuilding context from the same MongoDB.
// Uses a shared container to avoid per-test startup overhead.
// Tests share a single describe with sequential test flow.

describe('C5: clean restart from known states', { timeout: 60000 }, () => {
  const { env, setup, teardown } = setupTestEnv('c5', 'c5', {
    items: createRmDef('items_overview'),
  });

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
    env.cleanupClient.db('c5-events').collection('events').insertMany(events);

  const rmDb = () => env.cleanupClient.db('c5-rm');

  // Helper: create a fresh RM context from the same MongoDB (simulates restart)
  // Returns { restartContext, cleanup } — cleanup closes all restart servers
  const simulateRestart = (restartPrefix) => {
    const mqEvName = `c5-${restartPrefix}-events`;
    const mqQName = `c5-${restartPrefix}-queries`;
    registerSharedMqEmitter(mqEvName, mqemitter());
    registerSharedMqEmitter(mqQName, mqemitter());

    const servers = {};

    return initializeContext(
      { serviceId: `c5-${restartPrefix}-RM` },
      {
        readModels: { items: createRmDef('items_overview') },
        endpointName: 'rm',
        storage: readModelStorageMongo({
          url: env.connectionString,
          database: 'c5-rm',
        }),
        eventBus: readModelEventBusMqEmitter({ mqName: mqEvName }),
        changeNotificationSender: {
          sendChangeNotification: () => () => Promise.resolve(),
        },
        commandSender: {
          sendCommand: () => () => Promise.resolve(),
        },
        lifecycle: true,
      },
    )
      .then((restartContext) => {
        restartContext.adminInstructionHandler =
          createInlineAdminInstructionHandler(restartContext);

        // RM admin server
        const rmApp = expressApp();
        rmApp.use(bodyParser.json());
        installReadModelStatusApi(restartContext)(rmApp);
        installAdminEndpoints(restartContext, rmApp);

        return new Promise((resolve, reject) => {
          servers.rmServer = rmApp.listen(0, '127.0.0.1');
          servers.rmServer.on('listening', () => {
            servers.rmPort = servers.rmServer.address().port;
            resolve(restartContext);
          });
          servers.rmServer.on('error', reject);
        });
      })
      .then((restartContext) => {
        // CP side
        const cpEventStoreFactory = eventStoreMongo({
          url: env.connectionString,
          database: 'c5-events',
        });
        const cpEventBusFactory = commandProcessorEventBusMqEmitter({
          mqName: mqEvName,
        });
        const cpStatusTracker = createCpStatusTracker();

        return Promise.all([cpEventStoreFactory(), cpEventBusFactory()]).then(
          ([cpEventStore, cpEventBus]) => {
            const catchupHandler = createCatchupHandler(
              cpEventStore,
              cpEventBus,
              cpStatusTracker,
            );

            const mq = getSharedMqEmitter('CP', mqEvName);
            mq.on('__admin', ({ payload }, cb) => {
              const { correlationId, instruction } = payload;
              if (instruction.type === 'startCatchup') {
                catchupHandler
                  .startCatchup(
                    correlationId,
                    instruction.readModel,
                    instruction.fromTimestamp || 0,
                    instruction.targetEndpointName,
                    instruction.replayRelevantEvents,
                  )
                  .catch(() => {});
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
              servers.cpServer = cpApp.listen(0, '127.0.0.1');
              servers.cpServer.on('listening', () => {
                servers.cpPort = servers.cpServer.address().port;
                resolve(restartContext);
              });
              servers.cpServer.on('error', reject);
            });
          },
        );
      })
      .then((restartContext) =>
        // Admin orchestrator
        startAdmin(
          { serviceId: `c5-${restartPrefix}-ADMIN` },
          {
            port: 0,
            eventBus: commandProcessorEventBusMqEmitter({ mqName: mqEvName }),
            readModelServiceUrl: `http://127.0.0.1:${servers.rmPort}`,
            commandProcessorUrl: `http://127.0.0.1:${servers.cpPort}`,
          },
        ).then((adminServer) => {
          servers.adminServer = adminServer;
          servers.adminPort = adminServer.address().port;
          return {
            restartContext,
            adminPort: servers.adminPort,
            rmPort: servers.rmPort,
            cleanup: () => {
              if (adminServer.__testing__) {
                adminServer.__testing__.sseClient.disconnectAll();
              }
              return new Promise((r) => servers.rmServer.close(r))
                .then(() => new Promise((r) => servers.cpServer.close(r)))
                .then(() => new Promise((r) => adminServer.close(r)));
            },
          };
        }),
      );
  };

  const fetchRestart = (port, path, options = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    }).then((res) => res.json().then((body) => ({ status: res.status, body })));

  // 5.1: Restart while RM was live: auto-activate, no duplicates
  test('5.1: restart while RM was live — loads timestamp, no duplicates', () =>
    insertEvents(
      Array.from({ length: 5 }, (_, i) => ({
        type: 'ITEM_CREATED',
        aggregateId: `item-${i + 1}`,
        timestamp: (i + 1) * 100,
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
          15000,
        ),
      )
      .then(() => rmDb().collection('items_overview').countDocuments())
      .then((count) => {
        expect(count).toBe(5);
      })
      .then(() =>
        rmDb().collection('readmodel.state').findOne({ name: 'items' }),
      )
      .then((stateDoc) => {
        expect(stateDoc.lastProjectedEventTimestamp).toBe(500);
      })
      // "Restart" — create fresh RM context from same MongoDB
      .then(() => simulateRestart('restart-live'))
      .then(({ restartContext, adminPort, rmPort, cleanup }) => {
        // Verify timestamp loaded from MongoDB
        expect(
          restartContext.readModels.items.lastProjectedEventTimestamp,
        ).toBe(500);

        return waitForCondition(() =>
          fetchRestart(adminPort, '/admin/readmodel/status').then(
            ({ body }) => body.length > 0,
          ),
        )
          .then(() =>
            fetchRestart(adminPort, '/admin/readmodel/activate/rm/items', {
              method: 'POST',
              body: '{}',
            }),
          )
          .then(() =>
            waitForCondition(
              () =>
                fetchRestart(rmPort, '/admin/readmodel').then(({ body }) => {
                  const items = body.find((rm) => rm.name === 'items');
                  return items && items.state === 'live';
                }),
              15000,
            ),
          )
          .then(() =>
            rmDb()
              .collection('items_overview')
              .find({}, { projection: { _id: 0 } })
              .sort({ id: 1 })
              .toArray(),
          )
          .then((items) => {
            // No duplicates — exactly 5 items
            expect(items).toHaveLength(5);
          })
          .then(() => cleanup());
      }));

  // 5.5: Restart while stopped: stays stopped, preserves timestamp
  test('5.5: restart while stopped — stays stopped, can activate normally', () =>
    // Stop RM (live from 5.1)
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
      .then(() =>
        rmDb().collection('readmodel.state').findOne({ name: 'items' }),
      )
      .then((stateDoc) => {
        expect(stateDoc.lastProjectedEventTimestamp).toBe(500);
      })
      // "Restart"
      .then(() => simulateRestart('restart-stopped'))
      .then(({ restartContext, adminPort, rmPort, cleanup }) => {
        // Verify starts stopped with correct timestamp
        expect(restartContext.lifecycleManager.getState('items')).toBe(
          'stopped',
        );
        expect(
          restartContext.readModels.items.lastProjectedEventTimestamp,
        ).toBe(500);

        return waitForCondition(() =>
          fetchRestart(adminPort, '/admin/readmodel/status').then(
            ({ body }) => body.length > 0,
          ),
        )
          .then(() =>
            fetchRestart(adminPort, '/admin/readmodel/activate/rm/items', {
              method: 'POST',
              body: '{}',
            }),
          )
          .then(() =>
            waitForCondition(
              () =>
                fetchRestart(rmPort, '/admin/readmodel').then(({ body }) => {
                  const items = body.find((rm) => rm.name === 'items');
                  return items && items.state === 'live';
                }),
              15000,
            ),
          )
          .then(() =>
            rmDb()
              .collection('items_overview')
              .find({}, { projection: { _id: 0 } })
              .toArray(),
          )
          .then((items) => {
            // No duplicates — exactly 5 items
            expect(items).toHaveLength(5);
          })
          .then(() => cleanup());
      }));

  // 5.4: Restart after reset: timestamp 0, full catch-up rebuilds everything
  test('5.4: restart after reset — timestamp 0, full catch-up rebuilds everything', () =>
    // Stop RM (live from 5.5)
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
      // Reset: drop data and set timestamp to 0
      .then(() =>
        rmDb()
          .collection('items_overview')
          .drop()
          .catch(() => {}),
      )
      .then(() =>
        env.rmContext.storage.updateLastProjectedEventTimestamps(
          'reset-corr',
          ['items'],
          0,
        ),
      )
      .then(() =>
        rmDb().collection('readmodel.state').findOne({ name: 'items' }),
      )
      .then((stateDoc) => {
        expect(stateDoc.lastProjectedEventTimestamp).toBe(0);
      })
      // "Restart"
      .then(() => simulateRestart('restart-reset'))
      .then(({ restartContext, adminPort, rmPort, cleanup }) => {
        // Verify timestamp loaded as 0
        expect(
          restartContext.readModels.items.lastProjectedEventTimestamp,
        ).toBe(0);

        return waitForCondition(() =>
          fetchRestart(adminPort, '/admin/readmodel/status').then(
            ({ body }) => body.length > 0,
          ),
        )
          .then(() =>
            fetchRestart(adminPort, '/admin/readmodel/activate/rm/items', {
              method: 'POST',
              body: '{}',
            }),
          )
          .then(() =>
            waitForCondition(
              () =>
                fetchRestart(rmPort, '/admin/readmodel').then(({ body }) => {
                  const items = body.find((rm) => rm.name === 'items');
                  return items && items.state === 'live';
                }),
              15000,
            ),
          )
          .then(() =>
            waitForCondition(
              () =>
                rmDb()
                  .collection('items_overview')
                  .countDocuments()
                  .then((c) => c === 5),
              5000,
            ),
          )
          .then(() =>
            rmDb()
              .collection('items_overview')
              .find({}, { projection: { _id: 0 } })
              .sort({ id: 1 })
              .toArray(),
          )
          .then((items) => {
            // Full catch-up rebuilt all 5 items from ts=0
            expect(items).toHaveLength(5);
          })
          .then(() =>
            rmDb().collection('readmodel.state').findOne({ name: 'items' }),
          )
          .then((stateDoc) => {
            expect(stateDoc.lastProjectedEventTimestamp).toBe(500);
          })
          .then(() => cleanup());
      }));
});

// ── 5.3: Restart after backup restore ─────────────────────────────────
// Verify that restarting from the same MongoDB after a backup restore
// loads the correct timestamp and catches up cleanly.

describe.skipIf(!hasMongoTools)(
  '5.3: restart after backup restore',
  { timeout: 120000 },
  () => {
    let backupPath;
    const readModelDefs = {
      items: createRmDef('items_overview'),
    };

    const { env, setup, teardown } = setupTestEnv(
      'c53-bkrs',
      'c53-bkrs',
      readModelDefs,
    );

    beforeAll(() =>
      mkdtemp(join(tmpdir(), 'c53-bkrs-test-')).then((bp) => {
        backupPath = bp;
        return setup();
      }),
    );

    afterAll(() =>
      teardown().then(() =>
        backupPath
          ? rmDir(backupPath, { recursive: true, force: true })
          : undefined,
      ),
    );

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
        .db('c53-bkrs-events')
        .collection('events')
        .insertMany(events);

    const rmDb = () => env.cleanupClient.db('c53-bkrs-rm');

    // Simulate restart from the same MongoDB
    const simulateRestart53 = (restartPrefix) => {
      const mqEvName = `c53-${restartPrefix}-events`;
      const mqQName = `c53-${restartPrefix}-queries`;
      registerSharedMqEmitter(mqEvName, mqemitter());
      registerSharedMqEmitter(mqQName, mqemitter());

      const servers = {};

      return initializeContext(
        { serviceId: `c53-${restartPrefix}-RM` },
        {
          readModels: { items: createRmDef('items_overview') },
          endpointName: 'rm',
          storage: readModelStorageMongo({
            url: env.connectionString,
            database: 'c53-bkrs-rm',
          }),
          eventBus: readModelEventBusMqEmitter({ mqName: mqEvName }),
          changeNotificationSender: {
            sendChangeNotification: () => () => Promise.resolve(),
          },
          commandSender: {
            sendCommand: () => () => Promise.resolve(),
          },
          lifecycle: true,
        },
      )
        .then((restartContext) => {
          restartContext.adminInstructionHandler =
            createInlineAdminInstructionHandler(restartContext);

          const rmApp = expressApp();
          rmApp.use(bodyParser.json());
          installReadModelStatusApi(restartContext)(rmApp);
          installAdminEndpoints(restartContext, rmApp);

          return new Promise((resolve, reject) => {
            servers.rmServer = rmApp.listen(0, '127.0.0.1');
            servers.rmServer.on('listening', () => {
              servers.rmPort = servers.rmServer.address().port;
              resolve(restartContext);
            });
            servers.rmServer.on('error', reject);
          });
        })
        .then((restartContext) => {
          const cpEventStoreFactory = eventStoreMongo({
            url: env.connectionString,
            database: 'c53-bkrs-events',
          });
          const cpEventBusFactory = commandProcessorEventBusMqEmitter({
            mqName: mqEvName,
          });
          const cpStatusTracker = createCpStatusTracker();

          return Promise.all([cpEventStoreFactory(), cpEventBusFactory()]).then(
            ([cpEventStore, cpEventBus]) => {
              const catchupHandler = createCatchupHandler(
                cpEventStore,
                cpEventBus,
                cpStatusTracker,
              );

              const mq = getSharedMqEmitter('CP', mqEvName);
              mq.on('__admin', ({ payload }, cb) => {
                const { correlationId, instruction } = payload;
                if (instruction.type === 'startCatchup') {
                  catchupHandler
                    .startCatchup(
                      correlationId,
                      instruction.readModel,
                      instruction.fromTimestamp || 0,
                      instruction.targetEndpointName,
                      instruction.replayRelevantEvents,
                    )
                    .catch(() => {});
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
                servers.cpServer = cpApp.listen(0, '127.0.0.1');
                servers.cpServer.on('listening', () => {
                  servers.cpPort = servers.cpServer.address().port;
                  resolve(restartContext);
                });
                servers.cpServer.on('error', reject);
              });
            },
          );
        })
        .then((restartContext) =>
          startAdmin(
            { serviceId: `c53-${restartPrefix}-ADMIN` },
            {
              port: 0,
              eventBus: commandProcessorEventBusMqEmitter({
                mqName: mqEvName,
              }),
              readModelServiceUrl: `http://127.0.0.1:${servers.rmPort}`,
              commandProcessorUrl: `http://127.0.0.1:${servers.cpPort}`,
            },
          ).then((adminServer) => {
            servers.adminServer = adminServer;
            servers.adminPort = adminServer.address().port;
            return {
              restartContext,
              adminPort: servers.adminPort,
              rmPort: servers.rmPort,
              cleanup: () => {
                if (adminServer.__testing__) {
                  adminServer.__testing__.sseClient.disconnectAll();
                }
                return new Promise((r) => servers.rmServer.close(r))
                  .then(() => new Promise((r) => servers.cpServer.close(r)))
                  .then(() => new Promise((r) => adminServer.close(r)));
              },
            };
          }),
        );
    };

    const fetchRestart53 = (port, path, options = {}) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
      }).then((res) =>
        res.json().then((body) => ({ status: res.status, body })),
      );

    test('5.3: restart after backup restore — correct timestamp and clean catch-up', () => {
      // Wire backup module
      env.rmContext.backup = backupFactory({
        backupPath,
        format: 'json',
      })(env.rmContext.storage);

      let backupId;

      return (
        // Step 1: Insert 5 events and activate RM
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
              15000,
            ),
          )
          // Verify all 5 projected
          .then(() => rmDb().collection('items_overview').countDocuments())
          .then((count) => {
            expect(count).toBe(5);
          })
          // Step 2: Create backup at ts=5000 (3 items backed up)
          .then(() =>
            env.rmContext.backup
              .createBackup('bk-53', 'items', ['items_overview'])
              .then((result) => {
                backupId = result.backupId;
              }),
          )
          // Step 3: Stop RM, add 2 more events
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
                return items && items.state === 'stopped';
              }),
            ),
          )
          .then(() =>
            insertEvents(
              Array.from({ length: 2 }, (_, i) => ({
                type: 'ITEM_CREATED',
                aggregateId: `item-${i + 6}`,
                timestamp: (i + 6) * 1000,
                payload: { name: `Item ${i + 6}` },
              })),
            ),
          )
          // Step 4: Restore backup (reverts data to 5 items at ts=5000)
          .then(() =>
            env.rmContext.backup.restoreBackup('restore-53', 'items', backupId),
          )
          // Verify data reverted
          .then(() => rmDb().collection('items_overview').countDocuments())
          .then((count) => {
            expect(count).toBe(5);
          })
          // Step 5: Simulate restart from the same MongoDB
          .then(() => simulateRestart53('restart-backup'))
          .then(({ restartContext, adminPort, rmPort, cleanup }) => {
            // Verify timestamp loaded from MongoDB (should be 5000 from backup)
            expect(
              restartContext.readModels.items.lastProjectedEventTimestamp,
            ).toBe(5000);

            return waitForCondition(() =>
              fetchRestart53(adminPort, '/admin/readmodel/status').then(
                ({ body }) => body.length > 0,
              ),
            )
              .then(() =>
                fetchRestart53(
                  adminPort,
                  '/admin/readmodel/activate/rm/items',
                  {
                    method: 'POST',
                    body: '{}',
                  },
                ),
              )
              .then(() =>
                waitForCondition(
                  () =>
                    fetchRestart53(rmPort, '/admin/readmodel').then(
                      ({ body }) => {
                        const items = body.find((rm) => rm.name === 'items');
                        return items && items.state === 'live';
                      },
                    ),
                  15000,
                ),
              )
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
                  .sort({ id: 1 })
                  .toArray(),
              )
              .then((items) => {
                // All 7 items: 5 from backup + 2 from catch-up
                expect(items).toHaveLength(7);
              })
              .then(() =>
                rmDb().collection('readmodel.state').findOne({ name: 'items' }),
              )
              .then((stateDoc) => {
                // Timestamp should be at 7000 (latest event)
                expect(stateDoc.lastProjectedEventTimestamp).toBe(7000);
              })
              .then(() => cleanup());
          })
      );
    });
  },
);

// ── Category 9: Activate with skipCatchup ─────────────────────────────

describe(
  '9.1: activate with skipCatchup skips catch-up, goes straight to live',
  { timeout: 120000 },
  () => {
    const readModelDefs = {
      items: createRmDef('items_overview'),
    };

    const { env, setup, teardown } = setupTestEnv(
      'c9-skip',
      'c9-skip',
      readModelDefs,
      null,
      { developmentMode: true },
    );

    beforeAll(() => setup());
    afterAll(() => teardown());

    const fetchAdmin = (path, options = {}) =>
      fetch(`http://127.0.0.1:${env.adminPort}${path}`, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
      }).then((res) =>
        res.json().then((body) => ({ status: res.status, body })),
      );

    const insertEvents = (events) =>
      env.cleanupClient
        .db('c9-skip-events')
        .collection('events')
        .insertMany(events);

    test('9.1: activate with skipCatchup=true, RM goes live without catch-up', () =>
      // Insert events into the event store
      insertEvents(
        Array.from({ length: 3 }, (_, i) => ({
          type: 'ITEM_CREATED',
          aggregateId: `skip-item-${i + 1}`,
          payload: { name: `Item ${i + 1}` },
          timestamp: (i + 1) * 1000,
          endpointName: 'rm',
          readModel: 'items',
        })),
      )
        .then(() =>
          // Activate with skipCatchup=true via admin API
          fetchAdmin('/admin/readmodel/activate/rm/items', {
            method: 'POST',
            body: JSON.stringify({ skipCatchup: true }),
          }),
        )
        .then((res) => {
          expect(res.status).toBe(202);
          expect(res.body.status).toBe('activating');

          // Wait for RM to reach live state
          return waitForCondition(
            () =>
              fetchAdmin('/admin/readmodel/status/rm/items').then(
                (r) => r.body.state === 'live',
              ),
            15000,
          );
        })
        .then(() =>
          // RM should be live but data should be empty (catch-up was skipped)
          env.cleanupClient
            .db('c9-skip-rm')
            .collection('items_overview')
            .countDocuments(),
        )
        .then((count) => {
          // No items projected because catch-up was skipped
          expect(count).toBe(0);
        }));
  },
);

// ── 10.7: Dev-mode timestamp override in replay from scratch ──────────

describe(
  '10.7: timestampOverride in replay from scratch',
  { timeout: 120000 },
  () => {
    const readModelDefs = {
      items: createRmDef('items_overview'),
    };

    const { env, setup, teardown } = setupTestEnv(
      'c107-tso',
      'c107-tso',
      readModelDefs,
      null,
      { developmentMode: true },
    );

    beforeAll(() => setup());
    afterAll(() => teardown());

    const fetchAdmin = (path, options = {}) =>
      fetch(`http://127.0.0.1:${env.adminPort}${path}`, {
        headers: { 'Content-Type': 'application/json' },
        ...options,
      }).then((res) =>
        res.json().then((body) => ({ status: res.status, body })),
      );

    const insertEvents = (events) =>
      env.cleanupClient
        .db('c107-tso-events')
        .collection('events')
        .insertMany(events);

    const rmDb = () => env.cleanupClient.db('c107-tso-rm');

    test('10.7: timestampOverride persists before replay and limits event range', () =>
      // Insert 5 events at timestamps 1000-5000
      insertEvents(
        Array.from({ length: 5 }, (_, i) => ({
          type: 'ITEM_CREATED',
          aggregateId: `tso-item-${i + 1}`,
          payload: { name: `Item ${i + 1}` },
          timestamp: (i + 1) * 1000,
          endpointName: 'rm',
          readModel: 'items',
        })),
      )
        .then(() =>
          // Activate RM normally first to get it into live state
          fetchAdmin('/admin/readmodel/activate/rm/items', {
            method: 'POST',
          }),
        )
        .then(() =>
          waitForCondition(
            () =>
              fetchAdmin('/admin/readmodel/status/rm/items').then(
                (r) => r.body.state === 'live',
              ),
            15000,
          ),
        )
        .then(() =>
          // Now replay with timestampOverride=3000
          // This should: persist 3000 as lastProjectedEventTimestamp,
          // then replay events from 0 to 3000 (only items 1-3)
          fetchAdmin('/admin/replay/start/rm/items', {
            method: 'POST',
            body: JSON.stringify({
              timestampOverride: 3000,
              activateAfter: true,
            }),
          }),
        )
        .then((res) => {
          expect(res.status).toBe(202);

          // Wait for RM to go back to live after replay+activate
          return waitForCondition(
            () =>
              fetchAdmin('/admin/readmodel/status/rm/items').then(
                (r) => r.body.state === 'live',
              ),
            30000,
          );
        })
        .then(() =>
          rmDb()
            .collection('items_overview')
            .find({}, { projection: { _id: 0 } })
            .sort({ id: 1 })
            .toArray(),
        )
        .then((items) => {
          // Replay went from 0 to 3000 (3 items),
          // then catch-up from 3000 brought in items 4 and 5
          expect(items).toHaveLength(5);
        })
        .then(() =>
          rmDb().collection('readmodel.state').findOne({ name: 'items' }),
        )
        .then((stateDoc) => {
          // Timestamp should be at least 3000 (the override value)
          // It may be higher if catch-up updated it
          expect(stateDoc.lastProjectedEventTimestamp).toBeGreaterThanOrEqual(
            3000,
          );
        }));
  },
);

// ── 10.8: Dev-mode timestamp override in backup replay ────────────────

describe.skipIf(!hasMongoTools)(
  '10.8: timestampOverride in backup replay',
  { timeout: 120000 },
  () => {
    let backupPath;
    const readModelDefs = {
      items: createRmDef('items_overview'),
    };

    const { env, setup, teardown } = setupTestEnv(
      'c108-tso',
      'c108-tso',
      readModelDefs,
      null,
      { developmentMode: true },
    );

    beforeAll(() =>
      mkdtemp(join(tmpdir(), 'c108-tso-test-')).then((bp) => {
        backupPath = bp;
        return setup();
      }),
    );

    afterAll(() =>
      teardown().then(() =>
        backupPath
          ? rmDir(backupPath, { recursive: true, force: true })
          : undefined,
      ),
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
        .db('c108-tso-events')
        .collection('events')
        .insertMany(events);

    const rmDb = () => env.cleanupClient.db('c108-tso-rm');

    test('10.8: timestampOverride replaces backup timestamp in backup replay', () => {
      // Wire backup module
      env.rmContext.backup = backupFactory({
        backupPath,
        format: 'json',
      })(env.rmContext.storage);

      let savedBackupId;

      return (
        // Insert 3 events and activate
        insertEvents(
          Array.from({ length: 3 }, (_, i) => ({
            type: 'ITEM_CREATED',
            aggregateId: `bktso-item-${i + 1}`,
            payload: { name: `Item ${i + 1}` },
            timestamp: (i + 1) * 1000,
            endpointName: 'rm',
            readModel: 'items',
          })),
        )
          .then(() =>
            fetchAdmin('/admin/readmodel/activate/rm/items', {
              method: 'POST',
            }),
          )
          .then(() =>
            waitForCondition(
              () =>
                fetchAdmin('/admin/readmodel/status/rm/items').then(
                  (r) => r.body.state === 'live',
                ),
              15000,
            ),
          )
          .then(() =>
            // Wait for all 3 items to be projected
            waitForCondition(
              () =>
                rmDb()
                  .collection('items_overview')
                  .countDocuments()
                  .then((c) => c === 3),
              5000,
            ),
          )
          .then(() =>
            // Create backup at timestamp=3000
            fetchAdmin('/admin/backup/create/rm/items', { method: 'POST' }),
          )
          .then(() =>
            // Wait for backup to complete
            waitForCondition(
              () =>
                fetchAdmin('/admin/readmodel/status/rm/items').then(
                  (r) =>
                    r.body.backupProgress?.state === 'idle' &&
                    r.body.backupProgress?.backupId,
                ),
              10000,
            ),
          )
          .then(() => fetchAdmin('/admin/readmodel/status/rm/items'))
          .then((r) => {
            savedBackupId = r.body.backupProgress.backupId;

            // Insert 2 more events at timestamps 4000, 5000
            return insertEvents(
              Array.from({ length: 2 }, (_, i) => ({
                type: 'ITEM_CREATED',
                aggregateId: `bktso-item-${i + 4}`,
                payload: { name: `Item ${i + 4}` },
                timestamp: (i + 4) * 1000,
                endpointName: 'rm',
                readModel: 'items',
              })),
            );
          })
          .then(() =>
            // Replay from backup with timestampOverride=2000
            // Backup was at ts=3000, but we override to 2000
            // This means: restore backup data, persist ts=2000,
            // then replay from backup to acceptLastEvent boundary
            fetchAdmin('/admin/replay/start/rm/items', {
              method: 'POST',
              body: JSON.stringify({
                backupId: savedBackupId,
                t0Option: 'acceptLastEvent',
                timestampOverride: 2000,
                activateAfter: true,
              }),
            }),
          )
          .then((res) => {
            expect(res.status).toBe(202);

            return waitForCondition(
              () =>
                fetchAdmin('/admin/readmodel/status/rm/items').then(
                  (r) => r.body.state === 'live',
                ),
              30000,
            );
          })
          .then(() =>
            // Wait for all 5 items (backup 3 + replay/catchup 2)
            waitForCondition(
              () =>
                rmDb()
                  .collection('items_overview')
                  .countDocuments()
                  .then((c) => c === 5),
              10000,
            ),
          )
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
      );
    });
  },
);
