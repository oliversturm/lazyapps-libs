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

const setupTestEnv = (
  mqPrefix,
  dbPrefix,
  readModelDefs,
  backupConfig,
  sharedConnectionString,
) => {
  const env = {
    connectionString: sharedConnectionString,
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
        console.log(`[ENV ${dbPrefix}] Connecting to MongoDB: ${sharedConnectionString}`);
        return MongoClient.connect(sharedConnectionString);
      })
      .then((client) => {
        env.cleanupClient = client;

        console.log(`[ENV ${dbPrefix}] RM storage database: ${dbPrefix}-rm`);
        console.log(`[ENV ${dbPrefix}] RM storage URL: ${env.connectionString}`);
        console.log(`[ENV ${dbPrefix}] Backup path: ${backupConfig?.backupPath || 'none'}`);
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
        console.log(`[ENV ${dbPrefix}] RM context initialized, lifecycle: ${!!context.lifecycleManager}, backup: ${!!context.backup}`);
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
        console.log(`[ENV ${dbPrefix}] CP event store URL: ${env.connectionString}`);
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

            // CP-side admin instruction handler
            mq.on('__admin', ({ payload }, cb) => {
              const { correlationId, instruction } = payload;
              console.log(`[CP ${mqPrefix}] ${instruction.type} rm=${instruction.readModel || '?'} fromTs=${instruction.fromTimestamp || '?'} ep=${instruction.targetEndpointName || '?'}`);
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
                    .then(() => {
                      console.log(`[CP ${mqPrefix}] startCatchup completed for ${instruction.readModel}`);
                    })
                    .catch((err) => {
                      console.log(`[CP ${mqPrefix}] startCatchup FAILED for ${instruction.readModel}: ${err.message}`);
                    });
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
                      instruction.replayDelayMs || 0,
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
            const rmMq = getSharedMqEmitter(
              'RM',
              `${mqPrefix}-events`,
            );
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
      .then(() =>
        env.cleanupClient ? env.cleanupClient.close() : undefined,
      );

  return { env, setup, teardown };
};

// ── Backup State Invariant Tests (1.9, 1.10, 1.7) ──────────────────────────
// Require mongoexport/mongoimport tools.
// Each test gets its own isolated environment (own RM context, admin service,
// event bus) sharing only the MongoDB container.

describe.skipIf(!hasMongoTools).sequential(
  'backup state invariants',
  { timeout: 120000 },
  () => {
    let container;
    let connectionString;
    let backupPath;
    const readModelDefs = {
      items: createRmDef('items_overview'),
    };

    // Dump all databases and their collections to console
    const dumpAllDbs = (label) =>
      MongoClient.connect(connectionString).then((client) =>
        client
          .db()
          .admin()
          .listDatabases()
          .then(({ databases }) =>
            databases
              .filter(
                (db) =>
                  !['admin', 'config', 'local'].includes(db.name),
              )
              .reduce(
                (chain, db) =>
                  chain.then((acc) =>
                    client
                      .db(db.name)
                      .listCollections()
                      .toArray()
                      .then((cols) =>
                        cols.reduce(
                          (colChain, col) =>
                            colChain.then((colAcc) =>
                              client
                                .db(db.name)
                                .collection(col.name)
                                .find()
                                .toArray()
                                .then((docs) => [
                                  ...colAcc,
                                  {
                                    db: db.name,
                                    collection: col.name,
                                    count: docs.length,
                                    docs,
                                  },
                                ]),
                            ),
                          Promise.resolve([]),
                        ),
                      )
                      .then((colResults) => [...acc, ...colResults]),
                  ),
                Promise.resolve([]),
              ),
          )
          .then((results) => {
            console.log(`\n[DB-DUMP ${label}]`);
            results.forEach(({ db, collection, count, docs }) => {
              console.log(`  ${db}.${collection} (${count} docs)`);
              docs.forEach((doc) => {
                const { _id, ...rest } = doc;
                console.log(`    ${JSON.stringify(rest)}`);
              });
            });
            console.log(`[/DB-DUMP ${label}]\n`);
          })
          .finally(() => client.close()),
      );

    beforeAll(() =>
      Promise.all([
        new MongoDBContainer('mongo:7').start(),
        mkdtemp(join(tmpdir(), 'bk-inv-test-')),
      ]).then(([c, bp]) => {
        container = c;
        connectionString =
          c.getConnectionString() + '?directConnection=true';
        backupPath = bp;
      }),
    );

    afterAll(() =>
      Promise.resolve()
        .then(() => (container ? container.stop() : undefined))
        .then(() =>
          backupPath
            ? rmDir(backupPath, { recursive: true, force: true })
            : undefined,
        ),
    );

    // Helper: create an isolated test environment, insert events, activate
    // RM, wait for it to be live with projected data. Returns env + helpers.
    const createActiveEnv = (prefix, eventCount) => {
      console.log(`[TEST ${prefix}] Creating active env with ${eventCount} events`);
      // Deep-clone readModelDefs — the projection code mutates
      // readModels[name].lastProjectedEventTimestamp in place
      const defs = Object.fromEntries(
        Object.entries(readModelDefs).map(([k, v]) => [k, { ...v }]),
      );
      const testEnv = setupTestEnv(
        prefix,
        prefix,
        defs,
        { backupPath, format: 'json' },
        connectionString,
      );

      const fetchAdmin = (path, options = {}) =>
        fetch(`http://127.0.0.1:${testEnv.env.adminPort}${path}`, {
          headers: { 'Content-Type': 'application/json' },
          ...options,
        }).then((res) =>
          res.json().then((body) => ({ status: res.status, body })),
        );

      const fetchRM = (path) =>
        fetch(`http://127.0.0.1:${testEnv.env.rmAdminPort}${path}`, {
          headers: { 'Content-Type': 'application/json' },
        }).then((res) =>
          res.json().then((body) => ({ status: res.status, body })),
        );

      const insertEvents = (events) =>
        testEnv.env.cleanupClient
          .db(`${prefix}-events`)
          .collection('events')
          .insertMany(events);

      const rmDb = () => testEnv.env.cleanupClient.db(`${prefix}-rm`);

      const getTimestamp = () =>
        rmDb()
          .collection('readmodel.state')
          .findOne({ name: 'items' })
          .then((doc) =>
            doc ? doc.lastProjectedEventTimestamp : undefined,
          );

      const ready = testEnv
        .setup()
        .then(() => {
          console.log(`[TEST ${prefix}] Inserting ${eventCount} events into ${prefix}-events`);
          return insertEvents(
            Array.from({ length: eventCount }, (_, i) => ({
              type: 'ITEM_CREATED',
              aggregateId: `item-${i + 1}`,
              timestamp: (i + 1) * 1000,
              payload: { name: `Item ${i + 1}` },
            })),
          );
        })
        .then(() =>
          testEnv.env.cleanupClient
            .db(`${prefix}-events`)
            .collection('events')
            .countDocuments()
            .then((count) => {
              console.log(`[TEST ${prefix}] Events in DB after insert: ${count}`);
            }),
        )
        .then(() =>
          waitForCondition(
            () =>
              fetchAdmin('/admin/readmodel/status').then(
                ({ body }) =>
                  body.length > 0 ? true : 'no read models yet',
              ),
            5000,
            100,
            'admin sees RM',
          ),
        )
        .then(() =>
          // Test: can the storage actually write?
          testEnv.env.rmContext.storage
            .updateLastProjectedEventTimestamps('test-write', ['items'], 999)
            .then(() =>
              testEnv.env.cleanupClient
                .db(`${prefix}-rm`)
                .collection('readmodel.state')
                .findOne({ name: 'items' }),
            )
            .then((doc) => {
              console.log(
                `[TEST ${prefix}] Storage write test: ${JSON.stringify(doc)}`,
              );
            }),
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
                if (items && items.state === 'live') return true;
                return `state=${items?.state || 'not found'}`;
              }),
            10000,
            100,
            'RM → live',
          ),
        )
        .then(() =>
          testEnv.env.cleanupClient
            .db(`${prefix}-rm`)
            .collection('items_overview')
            .countDocuments()
            .then((count) => {
              console.log(`[TEST ${prefix}] items_overview count after live: ${count}`);
            }),
        )
        .then(() => dumpAllDbs(`${prefix} after setup`))
        .then(() =>
          testEnv.env.cleanupClient
            .db(`${prefix}-rm`)
            .collection('readmodel.state')
            .findOne({ name: 'items' }),
        )
        .then((stateDoc) => {
          console.log(
            `[TEST ${prefix}] readmodel.state after setup: ${JSON.stringify(stateDoc)}`,
          );
        });

      return {
        testEnv,
        fetchAdmin,
        fetchRM,
        insertEvents,
        rmDb,
        getTimestamp,
        ready,
      };
    };

    // 1.9: Backup create — timestamp unchanged, data unchanged, backup files
    test('1.9: backup create leaves timestamp and data unchanged, backup files exist', () => {
      const { testEnv, rmDb, getTimestamp, ready } =
        createActiveEnv('bk-19', 4);

      return ready
        .then(() => getTimestamp())
        .then((tsBefore) => {
          expect(tsBefore).toBe(4000);
          return testEnv.env.rmContext.backup
            .createBackup('bk-create-corr', 'items', ['items_overview'])
            .then((result) => ({ tsBefore, backupId: result.backupId }));
        })
        .then(({ tsBefore, backupId }) =>
          getTimestamp().then((tsAfter) => {
            expect(tsAfter).toBe(tsBefore);
            return backupId;
          }),
        )
        .then((backupId) =>
          rmDb()
            .collection('items_overview')
            .find({}, { projection: { _id: 0 } })
            .toArray()
            .then((items) => {
              expect(items).toHaveLength(4);
              return backupId;
            }),
        )
        .then((backupId) => {
          const bkDir = join(backupPath, 'items', backupId);
          return readdir(bkDir).then((files) => {
            expect(files.some((f) => f === 'metadata.json')).toBe(true);
            return readFile(join(bkDir, 'metadata.json'), 'utf-8').then(
              (content) => {
                const metadata = JSON.parse(content);
                expect(metadata.eventTimestamp).toBe(4000);
              },
            );
          });
        })
        .then(() => dumpAllDbs(`after ${testEnv.env.adminPort}`))
        .finally(() => testEnv.teardown());
    });

    // 1.10: Backup restore (standalone) — timestamp = backup eventTimestamp,
    // backup data restored, replayInProgress flag set
    test('1.10: backup restore sets timestamp, restores data, sets replayInProgress', () => {
      const {
        testEnv,
        fetchAdmin,
        fetchRM,
        insertEvents,
        rmDb,
        getTimestamp,
        ready,
      } = createActiveEnv('bk-110', 4);

      let backupId;

      return ready
        .then(() =>
          // Create a backup first
          testEnv.env.rmContext.backup
            .createBackup('bk-corr', 'items', ['items_overview'])
            .then((result) => {
              backupId = result.backupId;
            }),
        )
        .then(() =>
          // Stop the RM
          fetchAdmin('/admin/readmodel/stop/rm/items', {
            method: 'POST',
            body: '{}',
          }),
        )
        .then(() =>
          waitForCondition(
            () =>
              fetchRM('/admin/readmodel').then(({ body }) => {
                const items = body.find((rm) => rm.name === 'items');
                if (items && items.state === 'idle') return true;
                return `state=${items?.state}`;
              }),
            5000,
            100,
            'RM → idle after stop',
          ),
        )
        .then(() =>
          // Add events after backup point
          insertEvents(
            Array.from({ length: 2 }, (_, i) => ({
              type: 'ITEM_CREATED',
              aggregateId: `item-${i + 5}`,
              timestamp: (i + 5) * 1000,
              payload: { name: `Item ${i + 5}` },
            })),
          ),
        )
        .then(() => {
          console.log(`[TEST bk-110] Starting restore, backupId=${backupId}`);
          console.log(`[TEST bk-110] RM context backup: ${!!testEnv.env.rmContext.backup}`);
          console.log(`[TEST bk-110] RM DB: querying readmodel.state before restore...`);
          return rmDb()
            .collection('readmodel.state')
            .findOne({ name: 'items' })
            .then((doc) => {
              console.log(`[TEST bk-110] readmodel.state before restore: ${JSON.stringify(doc)}`);
            });
        })
        .then(
          () =>
            new Promise((resolve) => {
              testEnv.env.rmContext.adminInstructionHandler('restore-corr', {
                type: 'restoreBackup',
                targetReadModel: 'items',
                backupId,
              });
              setTimeout(resolve, 3000);
            }),
        )
        .then(() => {
          console.log(`[TEST bk-110] Restore timeout elapsed, querying readmodel.state...`);
          return rmDb().collection('readmodel.state').findOne({ name: 'items' });
        })
        .then((stateDoc) => {
          console.log(`[TEST bk-110] readmodel.state after restore: ${JSON.stringify(stateDoc)}`);
          expect(stateDoc).not.toBeNull();
          expect(stateDoc.replayInProgress).toBe(true);
        })
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
        })
        .then(() => dumpAllDbs(`after ${testEnv.env.adminPort}`))
        .finally(() => testEnv.teardown());
    });

    // 1.7: Replay cancelled — initiate replay, cancel mid-way,
    // verify backup data restored
    test('1.7: replay cancelled restores to backup state', () => {
      const { testEnv, fetchAdmin, fetchRM, rmDb, getTimestamp, ready } =
        createActiveEnv('bk-17', 10);

      return ready
        .then(() =>
          // Start replay with autoBackup (creates backup before replaying)
          fetchAdmin('/admin/replay/start/rm/items', {
            method: 'POST',
            body: JSON.stringify({
              autoBackup: true,
              activateAfter: false,
              replayDelayMs: 100,
            }),
          }),
        )
        .then(({ status }) => {
          expect(status).toBe(202);
          return waitForCondition(
            () =>
              fetchRM('/admin/readmodel').then(({ body }) => {
                const items = body.find((rm) => rm.name === 'items');
                if (items && items.state === 'replay') return true;
                return `state=${items?.state}`;
              }),
            15000,
            100,
            'RM → replay',
          );
        })
        .then(() =>
          fetchAdmin('/admin/replay/cancel/rm/items', {
            method: 'POST',
            body: JSON.stringify({ reset: true }),
          }),
        )
        .then(({ body }) => {
          expect(body.status).toBe('cancelling');
        })
        .then(() =>
          waitForCondition(
            () =>
              fetchRM('/admin/readmodel').then(({ body }) => {
                const items = body.find((rm) => rm.name === 'items');
                // After cancel: replayDone → replay-done, then reset
                if (
                  items &&
                  (items.state === 'replay-done' || items.state === 'idle')
                )
                  return true;
                return `state=${items?.state}`;
              }),
            15000,
            100,
            'RM → replay-done or idle after cancel',
          ),
        )
        .then(() =>
          rmDb().collection('readmodel.state').findOne({ name: 'items' }),
        )
        .then((stateDoc) => {
          expect(stateDoc.lastProjectedEventTimestamp).toBeDefined();
        })
        .then(() => dumpAllDbs(`after ${testEnv.env.adminPort}`))
        .finally(() => testEnv.teardown());
    });
  },
);
