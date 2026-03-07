import { describe, test, expect, vi, beforeAll, afterAll } from 'vitest';
import { MongoDBContainer } from '@testcontainers/mongodb';
import { MongoClient } from 'mongodb';
import expressApp from 'express';
import bodyParser from 'body-parser';

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
const { initializeContext } = await import('@lazyapps/readmodels/context.js');
const { installReadModelAdminApi } = await import('@lazyapps/admin-api');
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
  },
};

const waitForCondition = (fn, timeout = 15000, interval = 100) => {
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

describe('catch-up lifecycle integration', { timeout: 120000 }, () => {
  let container;
  let connectionString;
  let cleanupClient;
  let adminServer;
  let adminPort;
  let rmAdminServer;
  let rmAdminPort;
  let rmContext;

  beforeAll(() => {
    registerSharedMqEmitter('catchup-events', mqemitter());
    registerSharedMqEmitter('catchup-queries', mqemitter());

    return new MongoDBContainer('mongo:7')
      .start()
      .then((c) => {
        container = c;
        connectionString = c.getConnectionString() + '?directConnection=true';
        return MongoClient.connect(connectionString);
      })
      .then((client) => {
        cleanupClient = client;

        // Start admin server (CP-side: catchup start endpoint)
        return startAdmin(
          { serviceId: 'CATCHUP-TEST' },
          {
            port: 0,
            eventStore: eventStoreMongo({
              url: connectionString,
              database: 'catchup-events',
            }),
            readModelStorage: readModelStorageMongo({
              url: connectionString,
              database: 'catchup-rm',
            }),
            eventBus: commandProcessorEventBusMqEmitter({
              mqName: 'catchup-events',
            }),
            readModels: testReadModels,
          },
        );
      })
      .then((server) => {
        adminServer = server;
        adminPort = server.address().port;

        // Start read model service with catchupServiceUrl
        return initializeContext(
          { serviceId: 'CATCHUP-RM' },
          {
            readModels: testReadModels,
            storage: readModelStorageMongo({
              url: connectionString,
              database: 'catchup-rm',
            }),
            eventBus: readModelEventBusMqEmitter({
              mqName: 'catchup-events',
            }),
            changeNotificationSender: {
              sendChangeNotification: () => () => Promise.resolve(),
            },
            commandSender: {
              sendCommand: () => () => Promise.resolve(),
            },
            catchupServiceUrl: `http://127.0.0.1:${adminPort}`,
            autoActivate: false,
          },
        );
      })
      .then((context) => {
        rmContext = context;

        // Set up MQEmitter listener for queries
        return readModelListenerMqEmitter({
          mqName: 'catchup-queries',
        })(context);
      })
      .then(() => {
        // Create RM admin server with activate/status endpoints
        const app = expressApp();
        app.use(bodyParser.json());
        installReadModelAdminApi(rmContext)(app);

        return new Promise((resolve, reject) => {
          rmAdminServer = app.listen(0, '127.0.0.1');
          rmAdminServer.on('listening', () => {
            rmAdminPort = rmAdminServer.address().port;
            resolve();
          });
          rmAdminServer.on('error', reject);
        });
      });
  });

  afterAll(() =>
    Promise.resolve()
      .then(() =>
        rmAdminServer ? new Promise((r) => rmAdminServer.close(r)) : undefined,
      )
      .then(() =>
        adminServer ? new Promise((r) => adminServer.close(r)) : undefined,
      )
      .then(() => (cleanupClient ? cleanupClient.close() : undefined))
      .then(() => (container ? container.stop() : undefined)),
  );

  const fetchRM = (path, options = {}) =>
    fetch(`http://127.0.0.1:${rmAdminPort}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    }).then((res) => res.json().then((body) => ({ status: res.status, body })));

  const fetchAdmin = (path, options = {}) =>
    fetch(`http://127.0.0.1:${adminPort}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    }).then((res) => res.json().then((body) => ({ status: res.status, body })));

  const getCollection = (name) =>
    cleanupClient
      .db('catchup-rm')
      .collection(name)
      .find({}, { projection: { _id: 0 } })
      .sort({ id: 1 })
      .toArray();

  const insertEvents = (events) =>
    cleanupClient.db('catchup-events').collection('events').insertMany(events);

  test('full catch-up lifecycle: waiting -> activate -> catching-up -> live', () =>
    // Step 1: Verify read models start in waiting state
    fetchRM('/admin/readmodels')
      .then(({ status, body }) => {
        expect(status).toBe(200);
        expect(body).toHaveLength(2);
        const items = body.find((rm) => rm.name === 'items');
        const stats = body.find((rm) => rm.name === 'stats');
        expect(items.state).toBe('waiting');
        expect(stats.state).toBe('waiting');
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
      .then(() => getCollection('items_overview'))
      .then((items) => {
        expect(items).toHaveLength(0);
      })
      // Step 4: Activate the items read model
      .then(() =>
        fetchRM('/admin/readmodels/items/activate', {
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
          fetchRM('/admin/readmodels').then(({ body }) => {
            const items = body.find((rm) => rm.name === 'items');
            return items.state === 'live';
          }),
        ),
      )
      // Step 6: Verify all 5 events were projected
      .then(() => getCollection('items_overview'))
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
        cleanupClient
          .db('catchup-rm')
          .collection('readmodel.state')
          .findOne({ name: 'items' }),
      )
      .then((stateDoc) => {
        expect(stateDoc.lastProjectedEventTimestamp).toBe(500);
      }));

  test('activate-all brings all read models to live', () =>
    // Stats should still be in waiting state from previous test
    fetchRM('/admin/readmodels')
      .then(({ body }) => {
        const stats = body.find((rm) => rm.name === 'stats');
        expect(stats.state).toBe('waiting');
      })
      // Activate all waiting read models
      .then(() =>
        fetchRM('/admin/readmodels/activate-all', {
          method: 'POST',
          body: '{}',
        }),
      )
      .then(({ status, body }) => {
        expect(status).toBe(202);
        expect(body.status).toBe('activating');
        expect(body.readModels).toContain('stats');
      })
      // Wait for stats to reach live
      .then(() =>
        waitForCondition(() =>
          fetchRM('/admin/readmodels').then(({ body }) => {
            const stats = body.find((rm) => rm.name === 'stats');
            return stats.state === 'live';
          }),
        ),
      )
      // Verify stats projected the events
      .then(() =>
        cleanupClient
          .db('catchup-rm')
          .collection('stats_counter')
          .findOne({ id: 'total' }),
      )
      .then((doc) => {
        expect(doc.count).toBe(5);
      }));

  test('catch-up status endpoint returns progress', () =>
    fetchAdmin('/admin/catchup/items/status').then(({ status, body }) => {
      expect(status).toBe(200);
      expect(body).toHaveProperty('status');
      expect(body).toHaveProperty('readModel');
    }));

  test('cannot activate a read model that is already live', () =>
    fetchRM('/admin/readmodels/items/activate', {
      method: 'POST',
      body: '{}',
    }).then(({ status, body }) => {
      expect(status).toBe(409);
      expect(body.error).toMatch(/cannot activate/i);
    }));
});

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

        // Start read model service WITHOUT catchupServiceUrl
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
            // No catchupServiceUrl — backward compatible mode
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

  test('no lifecycle manager when catchupServiceUrl is not set', () => {
    expect(rmContext.lifecycleManager).toBeUndefined();
  });

  test('events are projected immediately without catch-up', () => {
    // Publish an event through the MQEmitter event bus
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
