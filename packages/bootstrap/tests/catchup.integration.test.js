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
  stats: {
    projections: {
      ITEM_CREATED: ({ storage }) =>
        storage
          .find('stats_counter', { id: 'total' })
          .toArray()
          .then((docs) => {
            const count = docs.length ? docs[0].count + 1 : 1;
            return storage.updateOne(
              'stats_counter',
              { id: 'total' },
              { $set: { id: 'total', count } },
              { upsert: true },
            );
          }),
    },
    resolvers: {
      total: (storage) =>
        storage
          .find('stats_counter', { id: 'total' })
          .toArray()
          .then((docs) => (docs.length ? docs[0] : null)),
    },
    collections: ['stats_counter'],
    replayRelevantEvents: ['ITEM_CREATED'],
  },
};

const waitForCondition = (fn, timeout = 30000, interval = 200) => {
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

// Admin instruction handler for RM side — handles the new camelCase types
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
        // Reset is handled by storage clearing — not needed for test
        break;
    }
  };
};

// Create a fresh copy of testReadModels to avoid cross-test contamination
// (projections mutate lastProjectedEventTimestamp on the read model object)
const cloneTestReadModels = () => ({
  items: {
    projections: { ...testReadModels.items.projections },
    resolvers: { ...testReadModels.items.resolvers },
    collections: [...testReadModels.items.collections],
    replayRelevantEvents: [...testReadModels.items.replayRelevantEvents],
  },
  stats: {
    projections: { ...testReadModels.stats.projections },
    resolvers: { ...testReadModels.stats.resolvers },
    collections: [...testReadModels.stats.collections],
    replayRelevantEvents: [...testReadModels.stats.replayRelevantEvents],
  },
});

// Helper to set up a full test environment: MongoDB + MQEmitter + RM + CP + Admin
const setupTestEnv = (mqPrefix, dbPrefix, { token } = {}) => {
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

        // Start RM context with lifecycle management
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
        // Set admin instruction handler (normally done by startReadModels)
        context.adminInstructionHandler =
          createInlineAdminInstructionHandler(context);
        if (token) {
          context.expectedAdminToken = token;
        }

        return readModelListenerMqEmitter({
          mqName: `${mqPrefix}-queries`,
        })(context);
      })
      .then(() => {
        // Create RM admin HTTP server with status + SSE endpoints
        const app = expressApp();
        app.use(bodyParser.json());
        // Status/readmodels listing
        installReadModelStatusApi(env.rmContext)(app);
        // SSE + replayRelevantEvents endpoints
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
        // Create CP-side event store, message bus, and status tracker
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

            // Create CP-side catch-up handler with status tracker
            const handler = createCatchupHandler(
              cpEventStore,
              cpEventBus,
              cpStatusTracker,
            );

            // Subscribe to __admin for CP-side instructions (camelCase)
            const mq = getSharedMqEmitter('CP', `${mqPrefix}-events`);
            mq.on('__admin', ({ payload }, cb) => {
              const { correlationId, instruction } = payload;
              switch (instruction.type) {
                case 'startCatchup':
                  handler
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
                  handler.cancelCatchup(correlationId, instruction.readModel);
                  break;
              }
              cb();
            });

            // Create CP HTTP server with status + SSE endpoints
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
      .then(() => {
        // Start admin server (orchestrator — delegates via message bus)
        return startAdmin(
          { serviceId: `${dbPrefix}-TEST` },
          {
            port: env.adminPort,
            eventBus: commandProcessorEventBusMqEmitter({
              mqName: `${mqPrefix}-events`,
            }),
            readModelServiceUrl: `http://127.0.0.1:${env.rmAdminPort}`,
            commandProcessorUrl: `http://127.0.0.1:${env.cpPort}`,
            ...(token && { token }),
          },
        );
      })
      .then((server) => {
        env.adminServer = server;
      });
  };

  const teardown = () =>
    Promise.resolve()
      .then(() => {
        // Disconnect admin SSE client to release connections
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

// ── Scenario 1 & 2: Full lifecycle + activate-all ──────────────────────────

describe('catch-up lifecycle integration', { timeout: 120000 }, () => {
  const { env, setup, teardown } = setupTestEnv('catchup', 'catchup');

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
      .db('catchup-events')
      .collection('events')
      .insertMany(events);

  test('full catch-up lifecycle: stopped -> activate -> catchup -> live', () =>
    // Step 1: Verify read models start in stopped state
    fetchRM('/admin/readmodel')
      .then(({ status, body }) => {
        expect(status).toBe(200);
        expect(body).toHaveLength(2);
        const items = body.find((rm) => rm.name === 'items');
        const stats = body.find((rm) => rm.name === 'stats');
        expect(items.state).toBe('stopped');
        expect(stats.state).toBe('stopped');
      })
      // Step 2: Insert events directly into event store
      .then(() =>
        insertEvents(
          Array.from({ length: 5 }, (_, i) => ({
            type: 'ITEM_CREATED',
            aggregateId: `item-${i + 1}`,
            timestamp: (i + 1) * 100,
            payload: { name: `Item ${i + 1}` },
          })),
        ),
      )
      // Step 3: Verify read model has NOT projected events
      .then(() =>
        env.cleanupClient
          .db('catchup-rm')
          .collection('items_overview')
          .find({}, { projection: { _id: 0 } })
          .sort({ id: 1 })
          .toArray(),
      )
      .then((items) => {
        expect(items).toHaveLength(0);
      })
      // Step 4: Activate items via admin server (orchestrator)
      .then(() =>
        fetchAdmin('/admin/readmodel/activate/rm/items', {
          method: 'POST',
          body: '{}',
        }),
      )
      .then(({ status, body }) => {
        expect(status).toBe(202);
        expect(body.status).toBe('activating');
      })
      // Step 5: Wait for items read model to reach live state
      .then(() =>
        waitForCondition(() =>
          fetchRM('/admin/readmodel').then(({ body }) => {
            const items = body.find((rm) => rm.name === 'items');
            return items.state === 'live';
          }),
        ),
      )
      // Step 6: Verify all 5 events were projected
      .then(() =>
        env.cleanupClient
          .db('catchup-rm')
          .collection('items_overview')
          .find({}, { projection: { _id: 0 } })
          .sort({ id: 1 })
          .toArray(),
      )
      .then((items) => {
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
      // Step 7: Verify lastProjectedEventTimestamp in DB
      .then(() =>
        env.cleanupClient
          .db('catchup-rm')
          .collection('readmodel.state')
          .findOne({ name: 'items' }),
      )
      .then((stateDoc) => {
        expect(stateDoc.lastProjectedEventTimestamp).toBe(500);
      }));

  test('activate-all brings all read models to live', () =>
    // Stats should still be in stopped state from previous test
    fetchRM('/admin/readmodel')
      .then(({ body }) => {
        const stats = body.find((rm) => rm.name === 'stats');
        expect(stats.state).toBe('stopped');
      })
      // Activate all via admin server (orchestrator)
      .then(() =>
        fetchAdmin('/admin/readmodel/activate-all', {
          method: 'POST',
          body: '{}',
        }),
      )
      .then(({ status, body }) => {
        expect(status).toBe(202);
        expect(body.status).toBe('activating');
        // Admin returns all RMs from its SSE cache
        expect(body.readModels).toBeDefined();
      })
      // Wait for stats to reach live
      .then(() =>
        waitForCondition(() =>
          fetchRM('/admin/readmodel').then(({ body }) => {
            const stats = body.find((rm) => rm.name === 'stats');
            return stats.state === 'live';
          }),
        ),
      )
      // Verify stats projected the events
      .then(() =>
        env.cleanupClient
          .db('catchup-rm')
          .collection('stats_counter')
          .findOne({ id: 'total' }),
      )
      .then((doc) => {
        expect(doc.count).toBe(5);
      }));

  test('RM remains live when already activated', () =>
    // Items is already live from earlier test
    fetchRM('/admin/readmodel').then(({ body }) => {
      const items = body.find((rm) => rm.name === 'items');
      expect(items.state).toBe('live');
    }));
});

// ── Scenario 2: Catch-up after gap ─────────────────────────────────────────

describe('catch-up after gap', { timeout: 120000 }, () => {
  const { env, setup, teardown } = setupTestEnv('gap', 'gap');

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
    env.cleanupClient.db('gap-events').collection('events').insertMany(events);

  test('fills gap after RM was stopped and events arrived', () =>
    // Step 1: Insert initial events
    insertEvents(
      Array.from({ length: 5 }, (_, i) => ({
        type: 'ITEM_CREATED',
        aggregateId: `item-${i + 1}`,
        timestamp: (i + 1) * 100,
        payload: { name: `Item ${i + 1}` },
      })),
    )
      // Step 2: Activate items RM → catch up to 5 events
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
      // Verify 5 items projected
      .then(() =>
        env.cleanupClient
          .db('gap-rm')
          .collection('items_overview')
          .countDocuments(),
      )
      .then((count) => {
        expect(count).toBe(5);
      })
      // Step 3: Stop items RM
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
            return items.state === 'stopped';
          }),
        ),
      )
      // Step 4: Insert more events while RM is stopped
      .then(() =>
        insertEvents(
          Array.from({ length: 5 }, (_, i) => ({
            type: 'ITEM_CREATED',
            aggregateId: `item-${i + 6}`,
            timestamp: (i + 6) * 100,
            payload: { name: `Item ${i + 6}` },
          })),
        ),
      )
      // Step 5: Re-activate items RM → should catch up the gap
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
      // Step 6: Verify all 10 events projected
      .then(() =>
        env.cleanupClient
          .db('gap-rm')
          .collection('items_overview')
          .find({}, { projection: { _id: 0 } })
          .sort({ id: 1 })
          .toArray(),
      )
      .then((items) => {
        // Verify all 10 unique items are present by aggregateId.
        const uniqueIds = [...new Set(items.map((it) => it.id))];
        expect(uniqueIds).toHaveLength(10);
        expect(uniqueIds).toContain('item-1');
        expect(uniqueIds).toContain('item-10');
      }));
});

// ── Scenario 4: Live events during catch-up (FIFO + dedup) ────────────────

describe(
  'catch-up with live events during catch-up',
  { timeout: 120000 },
  () => {
    const { env, setup, teardown } = setupTestEnv('liveev', 'liveev');

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

    test('live events queued in FIFO, deduped, then projected after catch-up', () =>
      // Step 1: Insert events into event store
      env.cleanupClient
        .db('liveev-events')
        .collection('events')
        .insertMany(
          Array.from({ length: 20 }, (_, i) => ({
            type: 'ITEM_CREATED',
            aggregateId: `item-${i + 1}`,
            timestamp: (i + 1) * 100,
            payload: { name: `Item ${i + 1}` },
          })),
        )
        // Step 2: Activate items RM via admin
        .then(() =>
          fetchAdmin('/admin/readmodel/activate/rm/items', {
            method: 'POST',
            body: '{}',
          }),
        )
        // Step 3: Wait for catching-up state, then emit overlapping live events
        .then(() =>
          waitForCondition(() =>
            fetchRM('/admin/readmodel').then(({ body }) => {
              const items = body.find((rm) => rm.name === 'items');
              return items.state === 'catchup' || items.state === 'live';
            }),
          ),
        )
        .then(() => {
          // Emit live events with timestamps overlapping catchup events
          // and extending beyond them
          const mq = getSharedMqEmitter('live-test', 'liveev-events');
          for (let i = 15; i <= 25; i++) {
            mq.emit({
              topic: 'events',
              payload: {
                correlationId: 'live-test',
                type: 'ITEM_CREATED',
                aggregateId: `item-${i}`,
                timestamp: i * 100,
                payload: { name: `Item ${i}` },
              },
            });
          }
        })
        // Step 4: Wait for live state
        .then(() =>
          waitForCondition(() =>
            fetchRM('/admin/readmodel').then(({ body }) => {
              const items = body.find((rm) => rm.name === 'items');
              return items.state === 'live';
            }),
          ),
        )
        // Step 5: Verify all items projected, check for duplicates
        .then(() =>
          env.cleanupClient
            .db('liveev-rm')
            .collection('items_overview')
            .find({}, { projection: { _id: 0 } })
            .sort({ id: 1 })
            .toArray(),
        )
        .then((items) => {
          // Should have items 1-25 (20 from catchup + 5 new from live)
          // Items 15-20 appear in both catchup and live but should NOT
          // be duplicated thanks to FIFO dedup
          expect(items.length).toBeGreaterThanOrEqual(20);
          expect(items.length).toBeLessThanOrEqual(30);

          // Check no duplicates by aggregateId
          const ids = items.map((it) => it.id);
          const uniqueIds = [...new Set(ids)];
          expect(ids.length).toBe(uniqueIds.length);
        }));
  },
);

// ── Scenario 8: Backward compatibility ────────────────────────────────────

describe('catch-up backward compatibility', { timeout: 120000 }, () => {
  let container;
  let connectionString;
  let cleanupClient;
  let rmContext;

  beforeAll(() => {
    registerSharedMqEmitter('compat-events', mqemitter());
    registerSharedMqEmitter('compat-queries', mqemitter());

    return new MongoDBContainer('mongo:7')
      .start()
      .then((c) => {
        container = c;
        connectionString = c.getConnectionString() + '?directConnection=true';
        return MongoClient.connect(connectionString);
      })
      .then((client) => {
        cleanupClient = client;

        // Start read model service WITHOUT lifecycle
        return initializeContext(
          { serviceId: 'COMPAT-RM' },
          {
            readModels: testReadModels,
            storage: readModelStorageMongo({
              url: connectionString,
              database: 'compat-rm',
            }),
            eventBus: readModelEventBusMqEmitter({
              mqName: 'compat-events',
            }),
            changeNotificationSender: {
              sendChangeNotification: () => () => Promise.resolve(),
            },
            commandSender: {
              sendCommand: () => () => Promise.resolve(),
            },
            // No lifecycle — backward compatible mode
          },
        );
      })
      .then((context) => {
        rmContext = context;
        return readModelListenerMqEmitter({
          mqName: 'compat-queries',
        })(context);
      });
  });

  afterAll(() =>
    Promise.resolve()
      .then(() => (cleanupClient ? cleanupClient.close() : undefined))
      .then(() => (container ? container.stop() : undefined)),
  );

  test('no lifecycle manager when lifecycle is not set', () => {
    expect(rmContext.lifecycleManager).toBeUndefined();
  });

  test('events are projected immediately without catch-up', () => {
    // Publish an event through the MQEmitter message bus
    const mq = getSharedMqEmitter('compat-test', 'compat-events');
    mq.emit({
      topic: 'events',
      payload: {
        correlationId: 'compat-test',
        type: 'ITEM_CREATED',
        aggregateId: 'compat-item-1',
        timestamp: 1000,
        payload: { name: 'Compat Item' },
      },
    });

    // Wait for projection
    return waitForCondition(() =>
      cleanupClient
        .db('compat-rm')
        .collection('items_overview')
        .findOne({ id: 'compat-item-1' })
        .then((doc) => !!doc),
    ).then(() =>
      cleanupClient
        .db('compat-rm')
        .collection('items_overview')
        .findOne({ id: 'compat-item-1' }, { projection: { _id: 0 } })
        .then((doc) => {
          expect(doc).toEqual({
            id: 'compat-item-1',
            name: 'Compat Item',
            ts: 1000,
          });
        }),
    );
  });
});

// ── Scenario 10: Admin instructions via message bus ───────────────────────

describe('admin instructions via message bus', { timeout: 120000 }, () => {
  const { env, setup, teardown } = setupTestEnv('adminmsg', 'adminmsg');

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

  test('activate and stop via admin orchestrator', () =>
    // Insert events
    env.cleanupClient
      .db('adminmsg-events')
      .collection('events')
      .insertMany(
        Array.from({ length: 3 }, (_, i) => ({
          type: 'ITEM_CREATED',
          aggregateId: `msg-item-${i + 1}`,
          timestamp: (i + 1) * 100,
          payload: { name: `Msg Item ${i + 1}` },
        })),
      )
      // Activate via admin
      .then(() =>
        fetchAdmin('/admin/readmodel/activate/rm/items', {
          method: 'POST',
          body: '{}',
        }),
      )
      .then(({ status }) => {
        expect(status).toBe(202);
      })
      // Wait for live
      .then(() =>
        waitForCondition(() =>
          fetchRM('/admin/readmodel').then(({ body }) => {
            const items = body.find((rm) => rm.name === 'items');
            return items.state === 'live';
          }),
        ),
      )
      // Stop via admin
      .then(() =>
        fetchAdmin('/admin/readmodel/stop/rm/items', {
          method: 'POST',
          body: '{}',
        }),
      )
      // Verify stopped
      .then(() =>
        waitForCondition(() =>
          fetchRM('/admin/readmodel').then(({ body }) => {
            const items = body.find((rm) => rm.name === 'items');
            return items.state === 'stopped';
          }),
        ),
      )
      .then(() =>
        fetchRM('/admin/readmodel').then(({ body }) => {
          const items = body.find((rm) => rm.name === 'items');
          expect(items.state).toBe('stopped');
        }),
      ));
});

// ── Scenario: Admin token auth rejection ──────────────────────────────────

describe('admin token auth', { timeout: 120000 }, () => {
  const adminToken = 'test-secret-token-12345';
  const { env, setup, teardown } = setupTestEnv('authtest', 'authtest', {
    token: adminToken,
  });

  beforeAll(setup);
  afterAll(teardown);

  test('rejects request without token', () =>
    fetch(`http://127.0.0.1:${env.adminPort}/admin/readmodel/status`, {
      headers: { 'Content-Type': 'application/json' },
    }).then((res) => {
      expect(res.status).toBe(401);
      return res.json().then((body) => {
        expect(body.error).toBe('Unauthorized');
      });
    }));

  test('rejects request with wrong token', () =>
    fetch(`http://127.0.0.1:${env.adminPort}/admin/readmodel/status`, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer wrong-token',
      },
    }).then((res) => {
      expect(res.status).toBe(401);
      return res.json().then((body) => {
        expect(body.error).toBe('Unauthorized');
      });
    }));

  test('accepts request with correct token', () =>
    fetch(`http://127.0.0.1:${env.adminPort}/admin/readmodel/status`, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
      },
    }).then((res) => {
      expect(res.status).toBe(200);
    }));
});
