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
const { createCatchupHandler } =
  await import('@lazyapps/command-processor/catchupHandler.js');
const { createCpStatusTracker } =
  await import('@lazyapps/command-processor/cpStatusTracker.js');
const { initializeContext } = await import('@lazyapps/readmodels/context.js');
const { installReadModelStatusApi } = await import('@lazyapps/admin-api');
const { installAdminEndpoints } = await import('@lazyapps/readmodels');
const { startAdmin } = await import('../admin.js');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

import { waitForCondition } from './helpers/waitForCondition.js';

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
});

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
    }
  };
};

// ── Full lifecycle with RabbitMQ message bus ───────────────────────────────

describe('catch-up lifecycle with RabbitMQ', { timeout: 30000 }, () => {
  let mongoContainer;
  let rabbitContainer;
  let connectionString;
  let amqpUrl;
  let cleanupClient;
  let adminServer;
  let adminPort;
  let rmAdminServer;
  let rmAdminPort;
  let cpServer;
  let cpPort;
  let rmContext;
  let readModels;
  let cpEventStore;
  let suppressErrors = false;
  let exchangeCounter = 0;

  const errorHandler = (err) => {
    if (suppressErrors) return;
    throw err;
  };

  const rejectionHandler = (reason) => {
    if (suppressErrors) return;
    throw reason;
  };

  const uniqueExchange = () =>
    `catchup-test-${Date.now()}-${exchangeCounter++}`;

  beforeAll(() => {
    process.on('uncaughtException', errorHandler);
    process.on('unhandledRejection', rejectionHandler);

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
        console.log(`[ENV rmq] Admin port: ${port}`);
        console.log(`[ENV rmq] MongoDB: ${connectionString}`);
        console.log(`[ENV rmq] RabbitMQ: ${amqpUrl}`);
        return MongoClient.connect(connectionString);
      })
      .then((client) => {
        cleanupClient = client;
        console.log(`[ENV rmq] RM storage database: rmq-rm`);

        // Start RM context with lifecycle + RabbitMQ message bus
        return initializeContext(
          { serviceId: 'RMQ-RM' },
          {
            readModels,
            endpointName: 'rm',
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
        console.log(`[ENV rmq] RM context initialized, lifecycle: ${!!context.lifecycleManager}`);
        context.adminInstructionHandler =
          createInlineAdminInstructionHandler(context);

        // Create RM admin HTTP server with status + SSE endpoints
        const app = expressApp();
        app.use(bodyParser.json());
        installReadModelStatusApi(rmContext)(app);
        installAdminEndpoints(rmContext, app);

        return new Promise((resolve, reject) => {
          rmAdminServer = app.listen(0, '127.0.0.1');
          rmAdminServer.on('listening', () => {
            rmAdminPort = rmAdminServer.address().port;
            console.log(`[ENV rmq] RM admin server on port ${rmAdminPort}`);
            resolve();
          });
          rmAdminServer.on('error', reject);
        });
      })
      .then(() => {
        // Create CP-side event store, message bus, and status tracker
        const cpStatusTracker = createCpStatusTracker();

        return eventStoreMongo({
          url: connectionString,
          database: 'rmq-events',
        })()
          .then((es) => {
            cpEventStore = es;
            return cpRabbitMq({
              url: amqpUrl,
              exchange,
              topic: 'events',
            })();
          })
          .then((cpEventBus) => {
            const handler = createCatchupHandler(
              cpEventStore,
              cpEventBus,
              cpStatusTracker,
            );

            // Subscribe to admin messages on the CP message bus
            return cpEventBus
              .subscribeAdminMessages((correlationId, instruction) => {
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
              })
              .then(() => {
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
                  cpServer = cpApp.listen(0, '127.0.0.1');
                  cpServer.on('listening', () => {
                    cpPort = cpServer.address().port;
                    console.log(`[ENV rmq] CP server on port ${cpPort}`);
                    resolve();
                  });
                  cpServer.on('error', reject);
                });
              });
          })
          .then(() => delay(1000));
      })
      .then(() => {
        // Start admin server with RabbitMQ message bus
        return startAdmin(
          { serviceId: 'RMQ-TEST' },
          {
            port: adminPort,
            eventBus: cpRabbitMq({
              url: amqpUrl,
              exchange,
              topic: 'events',
            }),
            readModelServiceUrl: `http://127.0.0.1:${rmAdminPort}`,
            commandProcessorUrl: `http://127.0.0.1:${cpPort}`,
          },
        );
      })
      .then((server) => {
        adminServer = server;
        console.log(`[ENV rmq] Admin service started, setup complete`);
      });
  }, 120000);

  afterAll(() => {
    suppressErrors = true;
    return Promise.resolve()
      .then(() =>
        adminServer ? new Promise((r) => adminServer.close(r)) : undefined,
      )
      .then(() =>
        rmAdminServer ? new Promise((r) => rmAdminServer.close(r)) : undefined,
      )
      .then(() =>
        cpServer ? new Promise((r) => cpServer.close(r)) : undefined,
      )
      .then(() => (cpEventStore ? cpEventStore.close() : undefined))
      .then(() => (cleanupClient ? cleanupClient.close() : undefined))
      .then(() => (mongoContainer ? mongoContainer.stop() : undefined))
      .then(() => (rabbitContainer ? rabbitContainer.stop() : undefined))
      .then(() => delay(500));
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

  test('full catch-up lifecycle via RabbitMQ: activate, gap, activate-all, stop', () =>
    // Step 1: Verify RM starts in idle state
    fetchRM('/admin/readmodel')
      .then(({ status, body }) => {
        expect(status).toBe(200);
        const items = body.find((rm) => rm.name === 'items');
        expect(items.state).toBe('idle');
      })
      // Step 2: Insert events into event store
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
      // Step 3: Activate via admin server (orchestrator uses RabbitMQ)
      .then(() =>
        fetchAdmin('/admin/readmodel/activate/rm/items', {
          method: 'POST',
          body: '{}',
        }),
      )
      .then(({ status }) => {
        expect(status).toBe(202);
      })
      // Step 4: Wait for live state (RabbitMQ has network latency)
      .then(() =>
        waitForCondition(() =>
          fetchRM('/admin/readmodel').then(({ body }) => {
            const items = body.find((rm) => rm.name === 'items');
            if (items && items.state === 'live') return true;
            return `state=${items?.state || 'not found'}`;
          }), 5000, 100, 'items → live (rmq)',
        ),
      )
      // Wait for all 5 events to be projected (RabbitMQ delivery may lag state transition)
      .then(() =>
        waitForCondition(() =>
          cleanupClient
            .db('rmq-rm')
            .collection('items_overview')
            .find({})
            .toArray()
            .then((items) => items.length === 5 ? true : `count=${items.length}`),
          5000, 100, 'rmq items projected (5)',
        ),
      )
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
      })
      // Step 5: Stop items RM, then catch up after gap
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
          }), 5000, 100, 'items → idle (rmq gap)',
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
          }), 5000, 100, 'items → live (rmq re-activate)',
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
      })
      // Step 6: activate-all — stats should still be idle
      .then(() => fetchRM('/admin/readmodel'))
      .then(({ body }) => {
        const stats = body.find((rm) => rm.name === 'stats');
        expect(stats.state).toBe('idle');
      })
      .then(() =>
        fetchAdmin('/admin/readmodel/activate-all', {
          method: 'POST',
          body: '{}',
        }),
      )
      .then(({ status }) => {
        expect(status).toBe(202);
      })
      .then(() =>
        waitForCondition(() =>
          fetchRM('/admin/readmodel').then(({ body }) => {
            const stats = body.find((rm) => rm.name === 'stats');
            if (stats && stats.state === 'live') return true;
            return `state=${stats?.state || 'not found'}`;
          }), 5000, 100, 'stats → live (rmq)',
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
      })
      // Step 7: Stop items via admin
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
          }), 5000, 100, 'items → idle (rmq stop)',
        ),
      ));
});
