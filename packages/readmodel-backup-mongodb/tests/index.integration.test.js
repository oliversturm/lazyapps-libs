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
    error: vi.fn(),
  }),
}));

const { mongodb } = await import('@lazyapps/readmodelstorage-mongodb');
const { mongoBackup } = await import('../index.js');

describe('readmodel-backup-mongodb integration', { timeout: 60000 }, () => {
  let container;
  let connectionString;
  let cleanupClient;
  let storage;
  let backup;

  beforeAll(async () => {
    container = await new MongoDBContainer('mongo:7').start();
    connectionString =
      container.getConnectionString() + '?directConnection=true';
    cleanupClient = await MongoClient.connect(connectionString);
    storage = await mongodb({
      url: connectionString,
      database: 'backup-test',
    })();
    backup = mongoBackup()(storage);
  });

  afterAll(async () => {
    if (storage) await storage.close();
    if (cleanupClient) await cleanupClient.close();
    if (container) await container.stop();
  });

  beforeEach(async () => {
    const db = cleanupClient.db('backup-test');
    const collections = await db.listCollections().toArray();
    for (const col of collections) {
      await db.collection(col.name).drop();
    }
  });

  test('createBackup copies collection data to backup collections', () => {
    const req = storage.perRequest('corr-1');
    return req
      .insertOne('customers', { name: 'Alice', city: 'Berlin' })
      .then(() => req.insertOne('customers', { name: 'Bob', city: 'Munich' }))
      .then(() => backup.createBackup('corr-1', 'overview', ['customers']))
      .then((result) => {
        expect(result.backupId).toMatch(/^backup_\d+_overview$/);
        expect(result.timestamp).toBeGreaterThan(0);
        expect(result.eventTimestamp).toBe(0);

        const db = cleanupClient.db('backup-test');
        return db
          .collection(`${result.backupId}_customers`)
          .find({})
          .toArray()
          .then((docs) => {
            expect(docs).toHaveLength(2);
            const names = docs.map((d) => d.name).sort();
            expect(names).toEqual(['Alice', 'Bob']);
          });
      });
  });

  test('createBackup records eventTimestamp from readmodel.state', () => {
    const timestamp = new Date('2026-01-15T10:00:00Z');
    return storage
      .updateLastProjectedEventTimestamps('corr-1', ['overview'], timestamp)
      .then(() =>
        storage.perRequest('corr-1').insertOne('customers', { name: 'Alice' }),
      )
      .then(() => backup.createBackup('corr-1', 'overview', ['customers']))
      .then((result) => {
        expect(result.eventTimestamp).toEqual(timestamp);
      });
  });

  test('createBackup handles multiple collections', () => {
    const req = storage.perRequest('corr-1');
    return req
      .insertOne('customers', { name: 'Alice' })
      .then(() => req.insertOne('orders', { item: 'Widget', qty: 3 }))
      .then(() =>
        backup.createBackup('corr-1', 'overview', ['customers', 'orders']),
      )
      .then((result) => {
        const db = cleanupClient.db('backup-test');
        return Promise.all([
          db.collection(`${result.backupId}_customers`).find({}).toArray(),
          db.collection(`${result.backupId}_orders`).find({}).toArray(),
        ]).then(([custs, ords]) => {
          expect(custs).toHaveLength(1);
          expect(ords).toHaveLength(1);
        });
      });
  });

  test('listBackups returns backups sorted by timestamp descending', () => {
    const req = storage.perRequest('corr-1');
    return req
      .insertOne('customers', { name: 'Alice' })
      .then(() => backup.createBackup('corr-1', 'overview', ['customers']))
      .then(() => backup.createBackup('corr-2', 'overview', ['customers']))
      .then(() => backup.listBackups('overview'))
      .then((backups) => {
        expect(backups).toHaveLength(2);
        expect(backups[0].timestamp).toBeGreaterThanOrEqual(
          backups[1].timestamp,
        );
        backups.forEach((b) => {
          expect(b).not.toHaveProperty('_id');
          expect(b.readModelName).toBe('overview');
        });
      });
  });

  test('listBackups returns empty array for unknown read model', () =>
    backup.listBackups('nonexistent').then((backups) => {
      expect(backups).toEqual([]);
    }));

  test('deleteBackup removes backup collections and metadata', () => {
    const req = storage.perRequest('corr-1');
    return req
      .insertOne('customers', { name: 'Alice' })
      .then(() => backup.createBackup('corr-1', 'overview', ['customers']))
      .then((result) =>
        backup.deleteBackup('corr-2', result.backupId).then(() => result),
      )
      .then((result) => {
        const db = cleanupClient.db('backup-test');
        return Promise.all([
          db.collection(`${result.backupId}_customers`).find({}).toArray(),
          backup.listBackups('overview'),
        ]).then(([docs, backups]) => {
          expect(docs).toHaveLength(0);
          expect(backups).toHaveLength(0);
        });
      });
  });

  test('deleteBackup resolves silently for nonexistent backup', () =>
    backup.deleteBackup('corr-1', 'nonexistent'));

  test('restoreBackup replaces collection data from backup', () => {
    const req = storage.perRequest('corr-1');
    return req
      .insertOne('customers', { name: 'Alice' })
      .then(() => req.insertOne('customers', { name: 'Bob' }))
      .then(() => backup.createBackup('corr-1', 'overview', ['customers']))
      .then((result) =>
        req
          .deleteMany('customers', {})
          .then(() =>
            req.insertOne('customers', { name: 'Charlie (post-backup)' }),
          )
          .then(() =>
            backup.restoreBackup('corr-2', 'overview', result.backupId),
          ),
      )
      .then(() => req.find('customers', {}).toArray())
      .then((docs) => {
        expect(docs).toHaveLength(2);
        const names = docs.map((d) => d.name).sort();
        expect(names).toEqual(['Alice', 'Bob']);
      });
  });

  test('restoreBackup rejects for nonexistent backup', () =>
    expect(
      backup.restoreBackup('corr-1', 'overview', 'nonexistent'),
    ).rejects.toThrow('Backup nonexistent not found'));

  test('clearCollections drops collections and resets timestamp', () => {
    const req = storage.perRequest('corr-1');
    const timestamp = new Date('2026-01-15T10:00:00Z');
    return req
      .insertOne('customers', { name: 'Alice' })
      .then(() =>
        storage.updateLastProjectedEventTimestamps(
          'corr-1',
          ['overview'],
          timestamp,
        ),
      )
      .then(() => backup.clearCollections('corr-2', 'overview', ['customers']))
      .then(() => {
        const db = cleanupClient.db('backup-test');
        return Promise.all([
          db.listCollections({ name: 'customers' }).toArray(),
          db.collection('readmodel.state').find({ name: 'overview' }).toArray(),
        ]).then(([cols, states]) => {
          expect(cols).toHaveLength(0);
          expect(states[0].lastProjectedEventTimestamp).toBe(0);
        });
      });
  });

  test('cleanupBackups removes backups exceeding maxCount', () => {
    const req = storage.perRequest('corr-1');
    return req
      .insertOne('customers', { name: 'Alice' })
      .then(() => backup.createBackup('corr-1', 'overview', ['customers']))
      .then(() => backup.createBackup('corr-2', 'overview', ['customers']))
      .then(() => backup.createBackup('corr-3', 'overview', ['customers']))
      .then(() => backup.cleanupBackups('overview', { maxCount: 1 }))
      .then(() => backup.listBackups('overview'))
      .then((backups) => {
        expect(backups).toHaveLength(1);
      });
  });
});
