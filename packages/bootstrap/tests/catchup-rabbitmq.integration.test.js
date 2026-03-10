import { describe, test, expect, vi, beforeAll, afterAll } from 'vitest';
import { MongoDBContainer } from '@testcontainers/mongodb';
import { RabbitMQContainer } from '@testcontainers/rabbitmq';
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

const { mongodb: eventStoreMongo } =
  await import('@lazyapps/eventstore-mongodb');
const { mongodb: readModelStorageMongo } =
  await import('@lazyapps/readmodelstorage-mongodb');
const { rabbitMq: cpRabbitMq } =
  await import('@lazyapps/eventbus-rabbitmq/command-receiver/index.js');
const { rabbitMq: rmRabbitMq } =
  await import('@lazyapps/eventbus-rabbitmq/readmodels/index.js');
const { initializeContext } = await import('@lazyapps/readmodels/context.js');
const { installReadModelAdminApi } = await import('@lazyapps/admin-api');
const { startAdmin } = await import('../admin.js');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForCondition = (fn, timeout = 60000, interval = 500) => {
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

const createTestReadModels = () => ({
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
});

const createInlineAdminInstructionHandler = (context) => {
  return (correlationId, instruction) => {
    const lm = context.lifecycleManager;
    if (!lm) return;
    switch (instruction.type) {
      case 'activate':
        if (instruction.targetReadModel) {
          lm.activate(instruction.targetReadModel).catch(() => {});
        }
        break;
      case 'stop':
        if (instruction.targetReadModel) {
          lm.stop(instruction.targetReadModel);
        }
        break;
      case 'restart':
        if (instruction.targetReadModel) {
          lm.stop(instruction.targetReadModel);
          lm.activate(instruction.targetReadModel).catch(() => {});
        }
        break;
      case 'query_state': {
        const { replyTopic, targetReadModel } = instruction;
        if (!replyTopic || !context.publishAdminReply) return;
        const names = targetReadModel
          ? [targetReadModel]
          : Object.keys(context.readModels);
        const result = names.map((name) => {
          const rm = context.readModels[name];
          return {
            name,
            lastProjectedEventTimestamp: rm.lastProjectedEventTimestamp || 0,
            state: lm.getState(name),
            collections: rm.collections || [name],
          };
        });
        context.publishAdminReply(replyTopic, {
          correlationId,
          readModels: result,
        });
        break;
      }
    }
  };
};

// ── Full lifecycle with RabbitMQ event bus ─────────────────────────────────

describe('catch-up lifecycle with RabbitMQ', { timeout: 180000 }, () => {
  let mongoContainer;
  let rabbitContainer;
  let connectionString;
  let amqpUrl;
  let cleanupClient;
  let adminServer;
  let adminPort;
  let rmAdminServer;
  let rmAdminPort;
  let rmContext;
  let readModels;
  let suppressErrors = false;
  let exchangeCounter = 0;

  const errorHandler = (err) => {
    if (suppressErrors && err.message === 'Unexpected close') return;
    throw err;
  };

  const uniqueExchange = () =>
    `catchup-test-${Date.now()}-${exchangeCounter++}`;

  beforeAll(() => {
    process.on('uncaughtException', errorHandler);

    readModels = createTestReadModels();

    const exchange = uniqueExchange();

    return Promise.all([
      getPort(),
      new MongoDBContainer('mongo:7').start(),
      new RabbitMQContainer('rabbitmq:3-management').start(),
    ])
      .then(([port, mongo, rabbit]) => {
        adminPort = port;
        mongoContainer = mongo;
        rabbitContainer = rabbit;
        connectionString =
          mongo.getConnectionString() + '?directConnection=true';
        amqpUrl = rabbit.getAmqpUrl();
        return MongoClient.connect(connectionString);
      })
      .then((client) => {
        cleanupClient = client;

        // Start RM context with lifecycle + RabbitMQ event bus
        return initializeContext(
          { serviceId: 'RMQ-RM' },
          {
            readModels,
            storage: readModelStorageMongo({
              url: connectionString,
              database: 'rmq-rm',
            }),
            eventBus: rmRabbitMq({
              url: amqpUrl,
              exchange,
              pattern: '#',
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
        rmContext = context;
        context.adminInstructionHandler =
          createInlineAdminInstructionHandler(context);

        // Create RM admin HTTP server
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
      })
      .then(() => {
        // Start admin server with RabbitMQ event bus (CP-side)
        return startAdmin(
          { serviceId: 'RMQ-TEST' },
          {
            port: adminPort,
            eventStore: eventStoreMongo({
              url: connectionString,
              database: 'rmq-events',
            }),
            readModelStorage: readModelStorageMongo({
              url: connectionString,
              database: 'rmq-rm',
            }),
            eventBus: cpRabbitMq({
              url: amqpUrl,
              exchange,
              topic: 'events',
            }),
            readModels,
          },
        );
      })
      .then((server) => {
        adminServer = server;
        // Allow RabbitMQ connections to settle
        return delay(1000);
      });
  }, 120000);

  afterAll(() => {
    suppressErrors = true;
    return Promise.resolve()
      .then(() =>
        rmAdminServer ? new Promise((r) => rmAdminServer.close(r)) : undefined,
      )
      .then(() =>
        adminServer ? new Promise((r) => adminServer.close(r)) : undefined,
      )
      .then(() => (cleanupClient ? cleanupClient.close() : undefined))
      .then(() => (mongoContainer ? mongoContainer.stop() : undefined))
      .then(() => (rabbitContainer ? rabbitContainer.stop() : undefined))
      .then(() => delay(500))
      .then(() => {
        process.removeListener('uncaughtException', errorHandler);
      });
  }, 60000);

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

  const insertEvents = (events) =>
    cleanupClient.db('rmq-events').collection('events').insertMany(events);

  test('full catch-up lifecycle via RabbitMQ: waiting -> activate -> live', () =>
    // Verify RM starts in waiting state
    fetchRM('/admin/readmodels')
      .then(({ status, body }) => {
        expect(status).toBe(200);
        const items = body.find((rm) => rm.name === 'items');
        expect(items.state).toBe('waiting');
      })
      // Insert events into event store
      .then(() =>
        insertEvents(
          Array.from({ length: 5 }, (_, i) => ({
            type: 'ITEM_CREATED',
            aggregateId: `rmq-item-${i + 1}`,
            timestamp: (i + 1) * 100,
            payload: { name: `RMQ Item ${i + 1}` },
          })),
        ),
      )
      // Activate via admin server (orchestrator uses RabbitMQ)
      .then(() =>
        fetchAdmin('/admin/readmodels/items/activate', {
          method: 'POST',
          body: '{}',
        }),
      )
      .then(({ status }) => {
        expect(status).toBe(202);
      })
      // Wait for live state (RabbitMQ has network latency)
      .then(() =>
        waitForCondition(() =>
          fetchRM('/admin/readmodels').then(({ body }) => {
            const items = body.find((rm) => rm.name === 'items');
            return items.state === 'live';
          }),
        ),
      )
      // Verify all 5 events projected
      .then(() =>
        cleanupClient
          .db('rmq-rm')
          .collection('items_overview')
          .find({}, { projection: { _id: 0 } })
          .sort({ id: 1 })
          .toArray(),
      )
      .then((items) => {
        expect(items).toHaveLength(5);
        expect(items[0]).toEqual({
          id: 'rmq-item-1',
          name: 'RMQ Item 1',
          ts: 100,
        });
        expect(items[4]).toEqual({
          id: 'rmq-item-5',
          name: 'RMQ Item 5',
          ts: 500,
        });
      }));

  test('catch-up after gap via RabbitMQ', () =>
    // Stop items RM
    fetchAdmin('/admin/readmodels/items/stop', {
      method: 'POST',
      body: '{}',
    })
      .then(() =>
        waitForCondition(() =>
          fetchRM('/admin/readmodels').then(({ body }) => {
            const items = body.find((rm) => rm.name === 'items');
            return items.state === 'stopped';
          }),
        ),
      )
      // Insert more events while stopped
      .then(() =>
        insertEvents(
          Array.from({ length: 5 }, (_, i) => ({
            type: 'ITEM_CREATED',
            aggregateId: `rmq-item-${i + 6}`,
            timestamp: (i + 6) * 100,
            payload: { name: `RMQ Item ${i + 6}` },
          })),
        ),
      )
      // Re-activate
      .then(() =>
        fetchAdmin('/admin/readmodels/items/activate', {
          method: 'POST',
          body: '{}',
        }),
      )
      .then(() =>
        waitForCondition(() =>
          fetchRM('/admin/readmodels').then(({ body }) => {
            const items = body.find((rm) => rm.name === 'items');
            return items.state === 'live';
          }),
        ),
      )
      // Verify all 10 unique items present
      .then(() =>
        cleanupClient
          .db('rmq-rm')
          .collection('items_overview')
          .find({}, { projection: { _id: 0 } })
          .toArray(),
      )
      .then((items) => {
        const uniqueIds = [...new Set(items.map((it) => it.id))];
        expect(uniqueIds).toHaveLength(10);
        expect(uniqueIds).toContain('rmq-item-1');
        expect(uniqueIds).toContain('rmq-item-10');
      }));

  test('activate-all via RabbitMQ', () =>
    // Stats should still be in waiting
    fetchRM('/admin/readmodels')
      .then(({ body }) => {
        const stats = body.find((rm) => rm.name === 'stats');
        expect(stats.state).toBe('waiting');
      })
      .then(() =>
        fetchAdmin('/admin/readmodels/activate-all', {
          method: 'POST',
          body: '{}',
        }),
      )
      .then(({ status }) => {
        expect(status).toBe(202);
      })
      .then(() =>
        waitForCondition(() =>
          fetchRM('/admin/readmodels').then(({ body }) => {
            const stats = body.find((rm) => rm.name === 'stats');
            return stats.state === 'live';
          }),
        ),
      )
      .then(() =>
        cleanupClient
          .db('rmq-rm')
          .collection('stats_counter')
          .findOne({ id: 'total' }),
      )
      .then((doc) => {
        expect(doc).not.toBeNull();
        expect(doc.count).toBeGreaterThanOrEqual(5);
      }));

  test('admin stop instruction via RabbitMQ', () =>
    fetchAdmin('/admin/readmodels/items/stop', {
      method: 'POST',
      body: '{}',
    }).then(() =>
      waitForCondition(() =>
        fetchRM('/admin/readmodels').then(({ body }) => {
          const items = body.find((rm) => rm.name === 'items');
          return items.state === 'stopped';
        }),
      ),
    ));
});
