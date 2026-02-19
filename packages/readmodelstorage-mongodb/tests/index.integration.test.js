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

const { mongodb } = await import('../index.js');

describe('readmodelstorage-mongodb', { timeout: 60000 }, () => {
  let container;
  let connectionString;
  let cleanupClient;
  let storage;

  beforeAll(async () => {
    container = await new MongoDBContainer('mongo:7').start();
    connectionString =
      container.getConnectionString() + '?directConnection=true';
    cleanupClient = await MongoClient.connect(connectionString);
    storage = await mongodb({ url: connectionString, database: 'testdb' })();
  });

  afterAll(async () => {
    if (storage) await storage.close();
    if (cleanupClient) await cleanupClient.close();
    if (container) await container.stop();
  });

  beforeEach(async () => {
    const db = cleanupClient.db('testdb');
    const collections = await db.listCollections().toArray();
    for (const col of collections) {
      await db.collection(col.name).drop();
    }
  });

  test('factory returns object with perRequest, close, updateLastProjectedEventTimestamps, readLastProjectedEventTimestamps', () => {
    expect(storage).toHaveProperty('perRequest');
    expect(storage).toHaveProperty('close');
    expect(storage).toHaveProperty('updateLastProjectedEventTimestamps');
    expect(storage).toHaveProperty('readLastProjectedEventTimestamps');
    expect(typeof storage.perRequest).toBe('function');
    expect(typeof storage.close).toBe('function');
    expect(typeof storage.updateLastProjectedEventTimestamps).toBe('function');
    expect(typeof storage.readLastProjectedEventTimestamps).toBe('function');
  });

  test('perRequest returns object with all 12 methods', () => {
    const req = storage.perRequest('corr-1');
    const expectedMethods = [
      'insertOne',
      'insertMany',
      'updateOne',
      'updateMany',
      'deleteOne',
      'deleteMany',
      'findOneAndUpdate',
      'findOneAndDelete',
      'findOneAndReplace',
      'bulkWrite',
      'find',
      'countDocuments',
    ];
    expectedMethods.forEach((method) => {
      expect(req).toHaveProperty(method);
      expect(typeof req[method]).toBe('function');
    });
  });

  test('insertOne inserts a document', () => {
    const req = storage.perRequest('corr-1');
    return req
      .insertOne('items', { name: 'test-item', value: 42 })
      .then((result) => {
        expect(result.acknowledged).toBe(true);
        expect(result.insertedId).toBeDefined();
      });
  });

  test('find retrieves inserted documents', () => {
    const req = storage.perRequest('corr-1');
    return req
      .insertOne('items', { name: 'find-test', value: 1 })
      .then(() => req.insertOne('items', { name: 'find-test-2', value: 2 }))
      .then(() => req.find('items', {}).toArray())
      .then((docs) => {
        expect(docs).toHaveLength(2);
        expect(docs[0].name).toBe('find-test');
        expect(docs[1].name).toBe('find-test-2');
      });
  });

  test('updateOne updates a document', () => {
    const req = storage.perRequest('corr-1');
    return req
      .insertOne('items', { name: 'update-test', value: 1 })
      .then(() =>
        req.updateOne(
          'items',
          { name: 'update-test' },
          { $set: { value: 99 } },
        ),
      )
      .then((result) => {
        expect(result.modifiedCount).toBe(1);
      })
      .then(() => req.find('items', { name: 'update-test' }).toArray())
      .then((docs) => {
        expect(docs[0].value).toBe(99);
      });
  });

  test('deleteOne deletes a document', () => {
    const req = storage.perRequest('corr-1');
    return req
      .insertOne('items', { name: 'delete-test' })
      .then(() => req.deleteOne('items', { name: 'delete-test' }))
      .then((result) => {
        expect(result.deletedCount).toBe(1);
      })
      .then(() => req.find('items', {}).toArray())
      .then((docs) => {
        expect(docs).toHaveLength(0);
      });
  });

  test('countDocuments returns correct count', () => {
    const req = storage.perRequest('corr-1');
    return req
      .insertOne('items', { name: 'a' })
      .then(() => req.insertOne('items', { name: 'b' }))
      .then(() => req.insertOne('items', { name: 'c' }))
      .then(() => req.countDocuments('items', {}))
      .then((count) => {
        expect(count).toBe(3);
      });
  });

  test('insertMany inserts multiple documents', () => {
    const req = storage.perRequest('corr-1');
    return req
      .insertMany('items', [
        { name: 'batch-1' },
        { name: 'batch-2' },
        { name: 'batch-3' },
      ])
      .then((result) => {
        expect(result.insertedCount).toBe(3);
      })
      .then(() => req.find('items', {}).toArray())
      .then((docs) => {
        expect(docs).toHaveLength(3);
      });
  });

  test('updateLastProjectedEventTimestamps upserts into readmodel.state collection', () => {
    const timestamp = new Date('2025-01-15T10:00:00Z');
    return storage
      .updateLastProjectedEventTimestamps('corr-1', ['rmA', 'rmB'], timestamp)
      .then(() => {
        const db = cleanupClient.db('testdb');
        return db.collection('readmodel.state').find({}).toArray();
      })
      .then((docs) => {
        expect(docs).toHaveLength(2);
        const names = docs.map((d) => d.name).sort();
        expect(names).toEqual(['rmA', 'rmB']);
        docs.forEach((doc) => {
          expect(doc.lastProjectedEventTimestamp).toEqual(timestamp);
        });
      });
  });

  test('updateLastProjectedEventTimestamps with empty array resolves immediately', () => {
    return storage
      .updateLastProjectedEventTimestamps('corr-1', [], new Date())
      .then((result) => {
        expect(result).toBeUndefined();
      });
  });

  test('readLastProjectedEventTimestamps reads timestamps back into readModels object', () => {
    const timestamp = new Date('2025-06-01T12:00:00Z');
    return storage
      .updateLastProjectedEventTimestamps(
        'corr-1',
        ['modelX', 'modelY'],
        timestamp,
      )
      .then(() => {
        const readModels = {
          modelX: {},
          modelY: {},
          modelZ: {},
        };
        return storage
          .readLastProjectedEventTimestamps(readModels)
          .then(() => readModels);
      })
      .then((readModels) => {
        expect(readModels.modelX.lastProjectedEventTimestamp).toEqual(
          timestamp,
        );
        expect(readModels.modelY.lastProjectedEventTimestamp).toEqual(
          timestamp,
        );
        expect(readModels.modelZ.lastProjectedEventTimestamp).toBeUndefined();
      });
  });

  describe('getCollectionNames', () => {
    test('returns data collection names', () => {
      const req = storage.perRequest('corr-gc1');
      return req
        .insertOne('items', { name: 'test' })
        .then(() => req.insertOne('orders', { name: 'order1' }))
        .then(() => storage.getCollectionNames())
        .then((names) => {
          expect(names).toContain('items');
          expect(names).toContain('orders');
        });
    });

    test('excludes readmodel.state', () => {
      const req = storage.perRequest('corr-gc2');
      return req
        .insertOne('items', { name: 'test' })
        .then(() =>
          storage.updateLastProjectedEventTimestamps(
            'corr-gc2',
            ['rm1'],
            new Date(),
          ),
        )
        .then(() => storage.getCollectionNames())
        .then((names) => {
          expect(names).not.toContain('readmodel.state');
        });
    });

    test('excludes collections starting with admin.', () => {
      const db = cleanupClient.db('testdb');
      return db
        .collection('admin.settings')
        .insertOne({ key: 'val' })
        .then(() => storage.perRequest('corr-gc3').insertOne('items', { a: 1 }))
        .then(() => storage.getCollectionNames())
        .then((names) => {
          expect(names).not.toContain('admin.settings');
          expect(names).toContain('items');
        });
    });

    test('excludes collections starting with backup_', () => {
      const db = cleanupClient.db('testdb');
      return db
        .collection('backup_items')
        .insertOne({ key: 'val' })
        .then(() => storage.perRequest('corr-gc4').insertOne('items', { a: 1 }))
        .then(() => storage.getCollectionNames())
        .then((names) => {
          expect(names).not.toContain('backup_items');
          expect(names).toContain('items');
        });
    });
  });

  describe('dropCollection', () => {
    test('drops an existing collection', () => {
      const req = storage.perRequest('corr-dc1');
      return req
        .insertOne('todrop', { name: 'test' })
        .then(() => storage.dropCollection('corr-dc1', 'todrop'))
        .then(() => {
          const db = cleanupClient.db('testdb');
          return db.listCollections({ name: 'todrop' }).toArray();
        })
        .then((cols) => {
          expect(cols).toHaveLength(0);
        });
    });

    test('ignores NamespaceNotFound for non-existent collection', () =>
      storage.dropCollection('corr-dc2', 'nonexistent').then((result) => {
        expect(result).toBeUndefined();
      }));
  });

  describe('copyCollection', () => {
    test('creates an exact copy of a collection', () => {
      const req = storage.perRequest('corr-cc1');
      return req
        .insertOne('source', { name: 'a', value: 1 })
        .then(() => req.insertOne('source', { name: 'b', value: 2 }))
        .then(() => storage.copyCollection('corr-cc1', 'source', 'dest'))
        .then(() => {
          const db = cleanupClient.db('testdb');
          return db.listCollections({ name: 'dest' }).toArray();
        })
        .then((cols) => {
          expect(cols).toHaveLength(1);
        });
    });

    test('copy has the same documents as the original', () => {
      const req = storage.perRequest('corr-cc2');
      return req
        .insertOne('source2', { name: 'x', value: 10 })
        .then(() => req.insertOne('source2', { name: 'y', value: 20 }))
        .then(() => storage.copyCollection('corr-cc2', 'source2', 'dest2'))
        .then(() => {
          const db = cleanupClient.db('testdb');
          return db.collection('dest2').find({}).toArray();
        })
        .then((docs) => {
          expect(docs).toHaveLength(2);
          const names = docs.map((d) => d.name).sort();
          expect(names).toEqual(['x', 'y']);
          const values = docs.map((d) => d.value).sort();
          expect(values).toEqual([10, 20]);
        });
    });
  });

  test('close works without error', () =>
    mongodb({
      url: connectionString,
      database: 'testdb_close',
    })().then((tempStorage) => tempStorage.close()));
});
