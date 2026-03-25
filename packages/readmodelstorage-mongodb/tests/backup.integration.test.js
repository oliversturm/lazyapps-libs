import {
  describe,
  test,
  expect,
  vi,
  beforeAll,
  afterAll,
  afterEach,
} from 'vitest';
import { MongoDBContainer } from '@testcontainers/mongodb';
import { MongoClient } from 'mongodb';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const hasMongoTools = (() => {
  try {
    execFileSync('mongoexport', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const hasMongoDump = (() => {
  try {
    execFileSync('mongodump', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const { mongodb } = await import('../index.js');
const { backup } = await import('../backup.js');

describe('backup integration', { timeout: 120000 }, () => {
  let container;
  let connectionString;
  let client;
  let db;
  let storage;
  let backupPath;

  beforeAll(async () => {
    container = await new MongoDBContainer('mongo:7').start();
    connectionString =
      container.getConnectionString() + '?directConnection=true';
    client = await MongoClient.connect(connectionString);
    db = client.db('backup-test');

    storage = await mongodb({
      url: connectionString,
      database: 'backup-test',
    })();
  });

  afterAll(async () => {
    if (storage) await storage.close();
    if (client) await client.close();
    if (container) await container.stop();
  });

  afterEach(async () => {
    if (backupPath) {
      await rm(backupPath, { recursive: true, force: true });
    }
    const collections = await db.listCollections().toArray();
    for (const col of collections) {
      await db.collection(col.name).drop();
    }
  });

  const createBackupPath = () =>
    mkdtemp(join(tmpdir(), 'backup-test-')).then((p) => {
      backupPath = p;
      return p;
    });

  describe.skipIf(!hasMongoTools)(
    'JSON format (mongoexport/mongoimport)',
    () => {
      test('create and list backup', () =>
        createBackupPath().then((bp) => {
          const b = backup({ backupPath: bp, format: 'json' })(storage);

          return db
            .collection('test_col')
            .insertMany([{ name: 'alice' }, { name: 'bob' }])
            .then(() => b.createBackup('corr-1', 'testRM', ['test_col']))
            .then((result) => {
              expect(result.backupId).toMatch(/^testRM__\d{4}-\d{2}-\d{2}T/);
              expect(result.timestamp).toBeGreaterThan(0);
              expect(result.eventTimestamp).toBe(0);

              return b.listBackups('testRM');
            })
            .then((backups) => {
              expect(backups).toHaveLength(1);
              expect(backups[0].readModelName).toBe('testRM');
              expect(backups[0].format).toBe('json');
              expect(backups[0].collections).toEqual(['test_col']);
              expect(backups[0].database).toBe('backup-test');

              return readdir(join(bp, 'testRM', backups[0].backupId));
            })
            .then((files) => {
              expect(files).toContain('metadata.json');
              expect(files).toContain('test_col.json');
            });
        }));

      test('restore backup verifies data round-trip', () =>
        createBackupPath().then((bp) => {
          const b = backup({ backupPath: bp, format: 'json' })(storage);

          return db
            .collection('test_col')
            .insertMany([{ name: 'alice' }, { name: 'bob' }])
            .then(() =>
              storage.updateLastProjectedEventTimestamps(
                'corr-1',
                ['testRM'],
                42000,
              ),
            )
            .then(() => b.createBackup('corr-1', 'testRM', ['test_col']))
            .then((result) => {
              const backupId = result.backupId;
              return db
                .collection('test_col')
                .insertMany([{ name: 'charlie' }, { name: 'dave' }])
                .then(() =>
                  storage.updateLastProjectedEventTimestamps(
                    'corr-1',
                    ['testRM'],
                    99000,
                  ),
                )
                .then(() => b.restoreBackup('corr-2', 'testRM', backupId));
            })
            .then(() => db.collection('test_col').find({}).toArray())
            .then((docs) => {
              expect(docs).toHaveLength(2);
              const names = docs.map((d) => d.name).sort();
              expect(names).toEqual(['alice', 'bob']);
              return db
                .collection('readmodel.state')
                .findOne({ name: 'testRM' });
            })
            .then((state) => {
              expect(state.lastProjectedEventTimestamp).toBe(42000);
            });
        }));

      test('delete backup removes directory', () =>
        createBackupPath().then((bp) => {
          const b = backup({ backupPath: bp, format: 'json' })(storage);

          return b
            .createBackup('corr-1', 'testRM', ['test_col'])
            .then((result) =>
              b
                .deleteBackup('corr-2', result.backupId)
                .then(() => b.listBackups('testRM')),
            )
            .then((backups) => {
              expect(backups).toHaveLength(0);
            });
        }));

      test('clear collections drops collections but preserves timestamps', () =>
        createBackupPath().then((bp) => {
          const b = backup({ backupPath: bp, format: 'json' })(storage);

          return db
            .collection('test_col')
            .insertMany([{ name: 'alice' }])
            .then(() =>
              storage.updateLastProjectedEventTimestamps(
                'corr-1',
                ['testRM'],
                50000,
              ),
            )
            .then(() => b.clearCollections('corr-1', 'testRM', ['test_col']))
            .then(() => db.collection('test_col').countDocuments())
            .then((count) => {
              expect(count).toBe(0);
              return db
                .collection('readmodel.state')
                .findOne({ name: 'testRM' });
            })
            .then((state) => {
              expect(state.lastProjectedEventTimestamp).toBe(50000);
            });
        }));

      test('clearCollections preserves lastProjectedEventTimestamp', () =>
        createBackupPath().then((bp) => {
          const b = backup({ backupPath: bp, format: 'json' })(storage);

          return db
            .collection('test_col')
            .insertMany([{ name: 'alice' }])
            .then(() =>
              storage.updateLastProjectedEventTimestamps(
                'corr-1',
                ['testRM'],
                50000,
              ),
            )
            .then(() => b.clearCollections('corr-1', 'testRM', ['test_col']))
            .then(() => db.collection('test_col').countDocuments())
            .then((count) => {
              // Collections should be cleared
              expect(count).toBe(0);
              return db
                .collection('readmodel.state')
                .findOne({ name: 'testRM' });
            })
            .then((state) => {
              // BUG: clearCollections resets timestamp to 0, but during
              // replay-from-backup the timestamp should be PRESERVED so
              // that catch-up after replay knows where to resume from.
              expect(state.lastProjectedEventTimestamp).toBe(50000);
            });
        }));

      test('retention: maxCount removes oldest backups', () =>
        createBackupPath().then((bp) => {
          const b = backup({ backupPath: bp, format: 'json' })(storage);

          const createWithDelay = (i) =>
            new Promise((resolve) => setTimeout(resolve, 50 * i)).then(() =>
              b.createBackup('corr-1', 'testRM', ['test_col']),
            );

          return createWithDelay(0)
            .then(() => createWithDelay(1))
            .then(() => createWithDelay(2))
            .then(() => b.cleanupBackups('testRM', { maxCount: 2 }))
            .then(() => b.listBackups('testRM'))
            .then((backups) => {
              expect(backups).toHaveLength(2);
            });
        }));

      test('retention: maxAge removes old backups', () =>
        createBackupPath().then((bp) => {
          const b = backup({ backupPath: bp, format: 'json' })(storage);

          return b
            .createBackup('corr-1', 'testRM', ['test_col'])
            .then((result) => {
              const metaPath = join(
                bp,
                'testRM',
                result.backupId,
                'metadata.json',
              );
              return readFile(metaPath, 'utf8')
                .then(JSON.parse)
                .then((meta) => {
                  meta.timestamp = Date.now() - 2 * 60 * 60 * 1000;
                  return import('node:fs/promises').then((fs) =>
                    fs.writeFile(metaPath, JSON.stringify(meta, null, 2)),
                  );
                });
            })
            .then(() => b.cleanupBackups('testRM', { maxAge: '1h' }))
            .then(() => b.listBackups('testRM'))
            .then((backups) => {
              expect(backups).toHaveLength(0);
            });
        }));

      test('listBackups returns empty for nonexistent read model', () =>
        createBackupPath().then((bp) => {
          const b = backup({ backupPath: bp, format: 'json' })(storage);
          return b.listBackups('nonexistent').then((backups) => {
            expect(backups).toEqual([]);
          });
        }));

      test('metadata.json contains timestamp and eventTimestamp fields', () =>
        createBackupPath().then((bp) => {
          const b = backup({ backupPath: bp, format: 'json' })(storage);

          return db
            .collection('test_col')
            .insertMany([{ name: 'alice' }])
            .then(() => b.createBackup('corr-1', 'testRM', ['test_col']))
            .then((result) =>
              readFile(
                join(bp, 'testRM', result.backupId, 'metadata.json'),
                'utf8',
              ).then(JSON.parse),
            )
            .then((metadata) => {
              expect(metadata).toHaveProperty('timestamp');
              expect(metadata).toHaveProperty('eventTimestamp');
              expect(typeof metadata.timestamp).toBe('number');
              expect(typeof metadata.eventTimestamp).toBe('number');
              expect(metadata.timestamp).toBeGreaterThan(0);
            });
        }));

      test('metadata.json eventTimestamp reflects lastProjectedEventTimestamp', () =>
        createBackupPath().then((bp) => {
          const b = backup({ backupPath: bp, format: 'json' })(storage);

          return db
            .collection('test_col')
            .insertMany([{ name: 'alice' }])
            .then(() =>
              storage.updateLastProjectedEventTimestamps(
                'corr-1',
                ['testRM'],
                55000,
              ),
            )
            .then(() => b.createBackup('corr-1', 'testRM', ['test_col']))
            .then((result) =>
              readFile(
                join(bp, 'testRM', result.backupId, 'metadata.json'),
                'utf8',
              ).then(JSON.parse),
            )
            .then((metadata) => {
              expect(metadata.eventTimestamp).toBe(55000);
              expect(metadata.timestamp).toBeGreaterThan(0);
              expect(metadata.backupId).toMatch(/^testRM__/);
              expect(metadata.readModelName).toBe('testRM');
              expect(metadata.collections).toEqual(['test_col']);
              expect(metadata.format).toBe('json');
              expect(metadata.database).toBe('backup-test');
            });
        }));

      test('metadata.json eventTimestamp is 0 when no events projected', () =>
        createBackupPath().then((bp) => {
          const b = backup({ backupPath: bp, format: 'json' })(storage);

          return b
            .createBackup('corr-1', 'testRM', ['test_col'])
            .then((result) =>
              readFile(
                join(bp, 'testRM', result.backupId, 'metadata.json'),
                'utf8',
              ).then(JSON.parse),
            )
            .then((metadata) => {
              expect(metadata.eventTimestamp).toBe(0);
            });
        }));

      test('restore uses metadata eventTimestamp to set lastProjectedEventTimestamp', () =>
        createBackupPath().then((bp) => {
          const b = backup({ backupPath: bp, format: 'json' })(storage);

          return db
            .collection('test_col')
            .insertMany([{ name: 'alice' }])
            .then(() =>
              storage.updateLastProjectedEventTimestamps(
                'corr-1',
                ['testRM'],
                77000,
              ),
            )
            .then(() => b.createBackup('corr-1', 'testRM', ['test_col']))
            .then((result) => {
              // Change the timestamp to something different
              return storage
                .updateLastProjectedEventTimestamps('corr-1', ['testRM'], 99000)
                .then(() =>
                  b.restoreBackup('corr-2', 'testRM', result.backupId),
                );
            })
            .then(() =>
              db.collection('readmodel.state').findOne({ name: 'testRM' }),
            )
            .then((state) => {
              // After restore, timestamp should match what was in the backup metadata
              expect(state.lastProjectedEventTimestamp).toBe(77000);
            });
        }));
    },
  );

  describe.skipIf(!hasMongoDump)('BSON format (mongodump/mongorestore)', () => {
    test('create and list backup', () =>
      createBackupPath().then((bp) => {
        const b = backup({ backupPath: bp, format: 'bson' })(storage);

        return db
          .collection('bson_col')
          .insertMany([{ name: 'alice' }, { name: 'bob' }])
          .then(() => b.createBackup('corr-1', 'testRM', ['bson_col']))
          .then((result) => {
            expect(result.backupId).toMatch(/^testRM__\d{4}-\d{2}-\d{2}T/);
            return b.listBackups('testRM');
          })
          .then((backups) => {
            expect(backups).toHaveLength(1);
            expect(backups[0].format).toBe('bson');
          });
      }));

    test('restore backup verifies data round-trip', () =>
      createBackupPath().then((bp) => {
        const b = backup({ backupPath: bp, format: 'bson' })(storage);

        return db
          .collection('bson_col')
          .insertMany([{ name: 'alice' }, { name: 'bob' }])
          .then(() =>
            storage.updateLastProjectedEventTimestamps(
              'corr-1',
              ['bsonRM'],
              42000,
            ),
          )
          .then(() => b.createBackup('corr-1', 'bsonRM', ['bson_col']))
          .then((result) => {
            const backupId = result.backupId;
            return db
              .collection('bson_col')
              .insertMany([{ name: 'charlie' }])
              .then(() => b.restoreBackup('corr-2', 'bsonRM', backupId));
          })
          .then(() => db.collection('bson_col').find({}).toArray())
          .then((docs) => {
            expect(docs).toHaveLength(2);
            const names = docs.map((d) => d.name).sort();
            expect(names).toEqual(['alice', 'bob']);
          });
      }));
  });
});
