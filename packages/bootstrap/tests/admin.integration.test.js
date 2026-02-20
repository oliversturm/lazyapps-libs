import {
  describe,
  test,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from 'vitest';
import { MongoDBContainer } from '@testcontainers/mongodb';
import { MongoClient } from 'mongodb';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { mongodb: eventStoreMongo } =
  await import('@lazyapps/eventstore-mongodb');
const { mongodb: readModelStorageMongo } =
  await import('@lazyapps/readmodelstorage-mongodb');
const { mongoBackup } = await import('@lazyapps/readmodel-backup-mongodb');
const { startAdmin } = await import('../admin.js');

describe('startAdmin integration', { timeout: 60000 }, () => {
  let container;
  let connectionString;
  let cleanupClient;
  let server;
  let adminPort;

  const readModels = {
    customers: {
      collections: ['customers_overview'],
      projections: {},
      resolvers: {},
    },
    orders: {
      collections: ['orders_overview'],
      projections: {},
      resolvers: {},
    },
  };

  beforeAll(async () => {
    container = await new MongoDBContainer('mongo:7').start();
    connectionString =
      container.getConnectionString() + '?directConnection=true';
    cleanupClient = await MongoClient.connect(connectionString);

    // Use port 0 to get a random available port
    server = await startAdmin(
      { serviceId: 'INTEGRATION-TEST' },
      {
        port: 0,
        eventStore: eventStoreMongo({ url: connectionString }),
        readModelStorage: readModelStorageMongo({
          url: connectionString,
          database: 'admin-test',
        }),
        eventBus: () =>
          Promise.resolve({
            publishReplayEvent: vi.fn().mockReturnValue(vi.fn()),
            publishSystemMessage: vi.fn().mockReturnValue(vi.fn()),
          }),
        backup: mongoBackup(),
        readModels,
      },
    );

    adminPort = server.address().port;
  });

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (cleanupClient) await cleanupClient.close();
    if (container) await container.stop();
  });

  beforeEach(async () => {
    const db = cleanupClient.db('admin-test');
    const collections = await db.listCollections().toArray();
    for (const col of collections) {
      await db.collection(col.name).drop();
    }
  });

  const fetchJSON = (path, options = {}) =>
    fetch(`http://127.0.0.1:${adminPort}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    }).then((res) => res.json().then((body) => ({ status: res.status, body })));

  test('GET /admin/status returns service info and read model list', () =>
    fetchJSON('/admin/status').then(({ status, body }) => {
      expect(status).toBe(200);
      expect(body.service).toBe('INTEGRATION-TEST');
      expect(typeof body.uptime).toBe('number');
      expect(body.readModels).toHaveLength(2);
      const names = body.readModels.map((rm) => rm.name).sort();
      expect(names).toEqual(['customers', 'orders']);
      body.readModels.forEach((rm) => {
        expect(rm.replaying).toBe(false);
      });
    }));

  test('GET /admin/readmodels returns read model details', () =>
    fetchJSON('/admin/readmodels').then(({ status, body }) => {
      expect(status).toBe(200);
      expect(body).toHaveLength(2);
      const customers = body.find((rm) => rm.name === 'customers');
      expect(customers.status).toBe('active');
      expect(customers.collections).toEqual(['customers_overview']);
    }));

  test('POST /admin/backup/:name creates a backup', () =>
    fetchJSON('/admin/backup/customers', { method: 'POST', body: '{}' }).then(
      ({ status, body }) => {
        expect(status).toBe(200);
        expect(body.backupId).toMatch(/^backup_\d+_customers$/);
        expect(body.timestamp).toBeGreaterThan(0);
      },
    ));

  test('GET /admin/backups/:name lists backups', () =>
    fetchJSON('/admin/backup/customers', { method: 'POST', body: '{}' })
      .then(() => fetchJSON('/admin/backups/customers'))
      .then(({ status, body }) => {
        expect(status).toBe(200);
        expect(body).toHaveLength(1);
        expect(body[0].readModelName).toBe('customers');
      }));

  test('DELETE /admin/backup/:id deletes a backup', () =>
    fetchJSON('/admin/backup/customers', { method: 'POST', body: '{}' })
      .then(({ body }) =>
        fetch(`http://127.0.0.1:${adminPort}/admin/backup/${body.backupId}`, {
          method: 'DELETE',
        }),
      )
      .then((res) => {
        expect(res.status).toBe(204);
      })
      .then(() => fetchJSON('/admin/backups/customers'))
      .then(({ body }) => {
        expect(body).toHaveLength(0);
      }));

  test('POST /admin/backup/:name returns 404 for unknown read model', () =>
    fetchJSON('/admin/backup/nonexistent', {
      method: 'POST',
      body: '{}',
    }).then(({ status, body }) => {
      expect(status).toBe(404);
      expect(body.error).toMatch(/not found/i);
    }));

  test('POST /api/admin/startReplay starts event replay', () =>
    fetchJSON('/api/admin/startReplay', {
      method: 'POST',
      body: JSON.stringify({
        readModel: 'customers',
        fromTimestamp: 0,
      }),
    }).then(({ status, body }) => {
      expect(status).toBe(200);
      expect(body).toHaveProperty('status');
    }));

  test('GET /api/admin/replayStatus/:name returns replay status', () =>
    fetchJSON('/api/admin/replayStatus/customers').then(({ status, body }) => {
      expect(status).toBe(200);
      expect(body).toHaveProperty('status');
    }));

  test('GET /admin/replay/:name/status reflects replay state', () =>
    fetchJSON('/admin/replay/customers/status').then(({ status, body }) => {
      expect(status).toBe(200);
      expect(body.readModel).toBe('customers');
      expect(body.status).toBe('idle');
    }));

  test('POST /admin/replay/:name/prepare prepares a replay', () =>
    fetchJSON('/admin/replay/customers/prepare', {
      method: 'POST',
      body: '{}',
    }).then(({ status, body }) => {
      expect(status).toBe(200);
      expect(body.status).toBe('prepared');
      expect(body.readModel).toBe('customers');
      expect(body.fromTimestamp).toBeDefined();
      expect(body.preReplayBackupId).toBeDefined();
    }));

  test('POST /admin/replay/:name/prepare returns 409 when already replaying', () =>
    fetchJSON('/admin/replay/customers/prepare', {
      method: 'POST',
      body: '{}',
    })
      .then(() =>
        fetchJSON('/admin/replay/customers/prepare', {
          method: 'POST',
          body: '{}',
        }),
      )
      .then(({ status, body }) => {
        expect(status).toBe(409);
        expect(body.error).toMatch(/already in progress/i);
      }));

  test('POST /api/admin/cancelReplay returns 400 for missing readModel', () =>
    fetchJSON('/api/admin/cancelReplay', {
      method: 'POST',
      body: '{}',
    }).then(({ status, body }) => {
      expect(status).toBe(400);
      expect(body.error).toMatch(/readModel is required/);
    }));

  test('POST /api/admin/cancelReplay returns cancelling status', () =>
    fetchJSON('/api/admin/cancelReplay', {
      method: 'POST',
      body: JSON.stringify({ readModel: 'customers' }),
    }).then(({ status, body }) => {
      expect(status).toBe(200);
      expect(body.status).toBe('cancelling');
      expect(body.readModel).toBe('customers');
    }));

  test('POST /api/admin/cancelReplay cancels an in-progress replay', () => {
    const eventsDb = cleanupClient.db('events');
    const eventsCol = eventsDb.collection('events');
    const events = Array.from({ length: 200 }, (_, i) => ({
      type: 'TEST_EVENT',
      aggregateId: `agg-${i}`,
      timestamp: i + 1,
      payload: {},
    }));
    return eventsCol
      .insertMany(events)
      .then(() =>
        fetchJSON('/api/admin/startReplay', {
          method: 'POST',
          body: JSON.stringify({
            readModel: 'orders',
            fromTimestamp: 0,
          }),
        }),
      )
      .then(({ status }) => {
        expect(status).toBe(200);
        return fetchJSON('/api/admin/cancelReplay', {
          method: 'POST',
          body: JSON.stringify({ readModel: 'orders' }),
        });
      })
      .then(({ status, body }) => {
        expect(status).toBe(200);
        expect(body.status).toBe('cancelling');
        expect(body.readModel).toBe('orders');
        return new Promise((resolve) => setTimeout(resolve, 1000));
      })
      .then(() => fetchJSON('/api/admin/replayStatus/orders'))
      .then(({ body }) => {
        expect(['cancelled', 'completed']).toContain(body.status);
      })
      .then(() => eventsCol.deleteMany({}));
  });

  test('POST /admin/replay/:name/prepare with fromScratch clears collections', () => {
    const db = cleanupClient.db('admin-test');
    // Clear any leftover replay state from prior tests (cancelReplay
    // doesn't work here because the event bus is mocked and won't
    // deliver REPLAY_CANCELLED to clear the projection handler state)
    server.__testing__.context.projectionHandler.clearReadModelReplayState(
      'customers',
    );
    return db
      .collection('customers_overview')
      .insertOne(
        // Insert a document into the customers_overview collection
        { name: 'existing-customer' },
      )
      .then(() =>
        fetchJSON('/admin/replay/customers/prepare', {
          method: 'POST',
          body: JSON.stringify({ fromScratch: true }),
        }),
      )
      .then(({ status, body }) => {
        expect(status).toBe(200);
        expect(body.status).toBe('prepared');
        expect(body.readModel).toBe('customers');
        expect(body.fromTimestamp).toBe(0);
        expect(body.preReplayBackupId).toBeDefined();
        // Verify the collection was cleared
        return db.collection('customers_overview').countDocuments();
      })
      .then((count) => {
        expect(count).toBe(0);
      });
  });

  test('POST /admin/replay/:name/prepare with backupId restores backup', () => {
    const db = cleanupClient.db('admin-test');
    // Clear any leftover replay state from prior tests
    server.__testing__.context.projectionHandler.clearReadModelReplayState(
      'customers',
    );
    return db
      .collection('customers_overview')
      .insertOne(
        // Insert a document so the backup has something
        { name: 'backup-customer' },
      )
      .then(() =>
        // Create a backup
        fetchJSON('/admin/backup/customers', {
          method: 'POST',
          body: '{}',
        }),
      )
      .then(({ status, body }) => {
        expect(status).toBe(200);
        const backupId = body.backupId;
        // Modify the collection so we can verify restore
        return db
          .collection('customers_overview')
          .insertOne({ name: 'post-backup-customer' })
          .then(() =>
            fetchJSON('/admin/replay/customers/prepare', {
              method: 'POST',
              body: JSON.stringify({ backupId }),
            }),
          )
          .then(({ status, body }) => {
            expect(status).toBe(200);
            expect(body.status).toBe('prepared');
            expect(body.readModel).toBe('customers');
            expect(body.fromTimestamp).toBeGreaterThanOrEqual(0);
            expect(body.preReplayBackupId).toBeDefined();
            // Verify the backup was restored (only the original document)
            return db.collection('customers_overview').countDocuments();
          })
          .then((count) => {
            expect(count).toBe(1);
            return db.collection('customers_overview').findOne({});
          })
          .then((doc) => {
            expect(doc.name).toBe('backup-customer');
          });
      });
  });
});
