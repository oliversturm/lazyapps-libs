import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  }),
}));

const { mongoBackup, __testing__ } = await import('../index.js');

describe('readmodel-backup-mongodb', () => {
  describe('parseMaxAge', () => {
    test('parses days', () => {
      expect(__testing__.parseMaxAge('7d')).toBe(7 * 24 * 60 * 60 * 1000);
    });

    test('parses hours', () => {
      expect(__testing__.parseMaxAge('6h')).toBe(6 * 60 * 60 * 1000);
    });

    test('parses minutes', () => {
      expect(__testing__.parseMaxAge('30m')).toBe(30 * 60 * 1000);
    });

    test('returns 0 for invalid input', () => {
      expect(__testing__.parseMaxAge('invalid')).toBe(0);
    });
  });

  describe('generateBackupId', () => {
    test('includes readModelName and timestamp', () => {
      const id = __testing__.generateBackupId('customers');
      expect(id).toMatch(/^backup_\d+_customers$/);
    });
  });

  describe('mongoBackup factory', () => {
    test('returns an object with all backup methods', () => {
      const storage = {};
      const backup = mongoBackup()(storage);
      expect(backup).toHaveProperty('createBackup');
      expect(backup).toHaveProperty('listBackups');
      expect(backup).toHaveProperty('restoreBackup');
      expect(backup).toHaveProperty('deleteBackup');
      expect(backup).toHaveProperty('clearCollections');
      expect(backup).toHaveProperty('cleanupBackups');
      expect(typeof backup.createBackup).toBe('function');
      expect(typeof backup.listBackups).toBe('function');
      expect(typeof backup.restoreBackup).toBe('function');
      expect(typeof backup.deleteBackup).toBe('function');
      expect(typeof backup.clearCollections).toBe('function');
      expect(typeof backup.cleanupBackups).toBe('function');
    });
  });

  describe('createBackup', () => {
    let storage;
    let backup;

    beforeEach(() => {
      const findCursor = {
        toArray: vi
          .fn()
          .mockResolvedValue([
            { name: 'customers', lastProjectedEventTimestamp: 5000 },
          ]),
      };
      storage = {
        copyCollection: vi.fn().mockResolvedValue(),
        perRequest: vi.fn().mockReturnValue({
          insertOne: vi.fn().mockResolvedValue({ acknowledged: true }),
          find: vi.fn().mockReturnValue(findCursor),
        }),
      };
      backup = mongoBackup()(storage);
    });

    test('copies each collection with backup prefix', () =>
      backup
        .createBackup('corr-1', 'customers', ['items', 'orders'])
        .then(() => {
          expect(storage.copyCollection).toHaveBeenCalledTimes(2);
          const call0 = storage.copyCollection.mock.calls[0];
          expect(call0[0]).toBe('corr-1');
          expect(call0[1]).toBe('items');
          expect(call0[2]).toMatch(/^backup_\d+_customers_items$/);
          const call1 = storage.copyCollection.mock.calls[1];
          expect(call1[1]).toBe('orders');
          expect(call1[2]).toMatch(/^backup_\d+_customers_orders$/);
        }));

    test('reads last projected event timestamp from readmodel.state', () =>
      backup.createBackup('corr-1', 'customers', ['items']).then(() => {
        const find = storage.perRequest('corr-1').find;
        expect(find).toHaveBeenCalledWith('readmodel.state', {
          name: 'customers',
        });
      }));

    test('stores metadata in admin.backups collection', () =>
      backup.createBackup('corr-1', 'customers', ['items']).then(() => {
        const insertOne = storage.perRequest('corr-1').insertOne;
        expect(insertOne).toHaveBeenCalledOnce();
        const args = insertOne.mock.calls[0];
        expect(args[0]).toBe('admin.backups');
        expect(args[1].readModelName).toBe('customers');
        expect(args[1].eventTimestamp).toBe(5000);
        expect(args[1].collections).toEqual(['items']);
        expect(args[1].backupId).toMatch(/^backup_\d+_customers$/);
      }));

    test('returns backupId, timestamp, and eventTimestamp', () =>
      backup.createBackup('corr-1', 'customers', ['items']).then((result) => {
        expect(result.backupId).toMatch(/^backup_\d+_customers$/);
        expect(typeof result.timestamp).toBe('number');
        expect(result.eventTimestamp).toBe(5000);
      }));

    test('defaults eventTimestamp to 0 when no state found', () => {
      const emptyFindCursor = {
        toArray: vi.fn().mockResolvedValue([]),
      };
      const emptyStorage = {
        copyCollection: vi.fn().mockResolvedValue(),
        perRequest: vi.fn().mockReturnValue({
          insertOne: vi.fn().mockResolvedValue({ acknowledged: true }),
          find: vi.fn().mockReturnValue(emptyFindCursor),
        }),
      };
      const b = mongoBackup()(emptyStorage);
      return b.createBackup('corr-1', 'newrm', ['items']).then((result) => {
        expect(result.eventTimestamp).toBe(0);
      });
    });
  });

  describe('listBackups', () => {
    test('queries metadata collection filtered by readModelName', () => {
      const mockCursor = {
        sort: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue([
          {
            _id: 'abc',
            backupId: 'backup_1000_rm1',
            readModelName: 'rm1',
            timestamp: 1000,
          },
        ]),
      };
      const storage = {
        perRequest: vi.fn().mockReturnValue({
          find: vi.fn().mockReturnValue(mockCursor),
        }),
      };
      const backup = mongoBackup()(storage);

      return backup.listBackups('rm1').then((result) => {
        expect(storage.perRequest('backup').find).toHaveBeenCalledWith(
          'admin.backups',
          { readModelName: 'rm1' },
        );
        expect(mockCursor.sort).toHaveBeenCalledWith({ timestamp: -1 });
        expect(result).toHaveLength(1);
        expect(result[0]).not.toHaveProperty('_id');
        expect(result[0].backupId).toBe('backup_1000_rm1');
      });
    });
  });

  describe('restoreBackup', () => {
    let storage;
    let backup;

    beforeEach(() => {
      const mockCursor = {
        toArray: vi.fn().mockResolvedValue([
          {
            backupId: 'backup_1000_rm1',
            readModelName: 'rm1',
            eventTimestamp: 5000,
            collections: ['items', 'orders'],
          },
        ]),
      };
      storage = {
        dropCollection: vi.fn().mockResolvedValue(),
        copyCollection: vi.fn().mockResolvedValue(),
        updateLastProjectedEventTimestamps: vi.fn().mockResolvedValue(),
        perRequest: vi.fn().mockReturnValue({
          find: vi.fn().mockReturnValue(mockCursor),
        }),
      };
      backup = mongoBackup()(storage);
    });

    test('drops current collections and copies from backup', () =>
      backup.restoreBackup('corr-1', 'rm1', 'backup_1000_rm1').then(() => {
        expect(storage.dropCollection).toHaveBeenCalledTimes(2);
        expect(storage.dropCollection).toHaveBeenCalledWith('corr-1', 'items');
        expect(storage.dropCollection).toHaveBeenCalledWith('corr-1', 'orders');
        expect(storage.copyCollection).toHaveBeenCalledTimes(2);
        expect(storage.copyCollection).toHaveBeenCalledWith(
          'corr-1',
          'backup_1000_rm1_items',
          'items',
        );
        expect(storage.copyCollection).toHaveBeenCalledWith(
          'corr-1',
          'backup_1000_rm1_orders',
          'orders',
        );
      }));

    test('restores lastProjectedEventTimestamp', () =>
      backup.restoreBackup('corr-1', 'rm1', 'backup_1000_rm1').then(() => {
        expect(storage.updateLastProjectedEventTimestamps).toHaveBeenCalledWith(
          'corr-1',
          ['rm1'],
          5000,
        );
      }));

    test('rejects if backup not found', () => {
      const emptyStorage = {
        perRequest: vi.fn().mockReturnValue({
          find: vi.fn().mockReturnValue({
            toArray: vi.fn().mockResolvedValue([]),
          }),
        }),
      };
      const b = mongoBackup()(emptyStorage);
      return expect(
        b.restoreBackup('corr-1', 'rm1', 'nonexistent'),
      ).rejects.toThrow('Backup nonexistent not found');
    });
  });

  describe('deleteBackup', () => {
    test('drops backup collections and removes metadata', () => {
      const mockCursor = {
        toArray: vi.fn().mockResolvedValue([
          {
            backupId: 'backup_1000_rm1',
            collections: ['items'],
          },
        ]),
      };
      const storage = {
        dropCollection: vi.fn().mockResolvedValue(),
        perRequest: vi.fn().mockReturnValue({
          find: vi.fn().mockReturnValue(mockCursor),
          deleteOne: vi.fn().mockResolvedValue(),
        }),
      };
      const backup = mongoBackup()(storage);

      return backup.deleteBackup('corr-1', 'backup_1000_rm1').then(() => {
        expect(storage.dropCollection).toHaveBeenCalledWith(
          'corr-1',
          'backup_1000_rm1_items',
        );
        expect(storage.perRequest('corr-1').deleteOne).toHaveBeenCalledWith(
          'admin.backups',
          {
            backupId: 'backup_1000_rm1',
          },
        );
      });
    });

    test('no-ops when backup does not exist', () => {
      const storage = {
        perRequest: vi.fn().mockReturnValue({
          find: vi.fn().mockReturnValue({
            toArray: vi.fn().mockResolvedValue([]),
          }),
        }),
      };
      const backup = mongoBackup()(storage);

      return backup.deleteBackup('corr-1', 'nonexistent').then((result) => {
        expect(result).toBeUndefined();
      });
    });
  });

  describe('clearCollections', () => {
    test('drops all specified collections and resets timestamp to 0', () => {
      const storage = {
        dropCollection: vi.fn().mockResolvedValue(),
        updateLastProjectedEventTimestamps: vi.fn().mockResolvedValue(),
      };
      const backup = mongoBackup()(storage);

      return backup
        .clearCollections('corr-1', 'rm1', ['items', 'orders'])
        .then(() => {
          expect(storage.dropCollection).toHaveBeenCalledTimes(2);
          expect(storage.dropCollection).toHaveBeenCalledWith(
            'corr-1',
            'items',
          );
          expect(storage.dropCollection).toHaveBeenCalledWith(
            'corr-1',
            'orders',
          );
          expect(
            storage.updateLastProjectedEventTimestamps,
          ).toHaveBeenCalledWith('corr-1', ['rm1'], 0);
        });
    });
  });

  describe('cleanupBackups', () => {
    test('deletes backups exceeding maxCount', () => {
      const backups = [
        {
          backupId: 'b3',
          timestamp: 3000,
          collections: ['items'],
          readModelName: 'rm1',
        },
        {
          backupId: 'b2',
          timestamp: 2000,
          collections: ['items'],
          readModelName: 'rm1',
        },
        {
          backupId: 'b1',
          timestamp: 1000,
          collections: ['items'],
          readModelName: 'rm1',
        },
      ];
      const mockCursor = {
        sort: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue(backups),
      };
      const storage = {
        dropCollection: vi.fn().mockResolvedValue(),
        perRequest: vi.fn().mockReturnValue({
          find: vi.fn().mockReturnValue(mockCursor),
          deleteOne: vi.fn().mockResolvedValue(),
        }),
      };
      const backup = mongoBackup()(storage);

      return backup.cleanupBackups('rm1', { maxCount: 2 }).then(() => {
        expect(storage.dropCollection).toHaveBeenCalledWith(
          'cleanup',
          'b1_items',
        );
        expect(storage.perRequest('cleanup').deleteOne).toHaveBeenCalledWith(
          'admin.backups',
          { backupId: 'b1' },
        );
      });
    });

    test('no-ops when within retention limits', () => {
      const backups = [
        {
          backupId: 'b1',
          timestamp: Date.now(),
          collections: ['items'],
          readModelName: 'rm1',
        },
      ];
      const mockCursor = {
        sort: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue(backups),
      };
      const storage = {
        dropCollection: vi.fn().mockResolvedValue(),
        perRequest: vi.fn().mockReturnValue({
          find: vi.fn().mockReturnValue(mockCursor),
          deleteOne: vi.fn().mockResolvedValue(),
        }),
      };
      const backup = mongoBackup()(storage);

      return backup.cleanupBackups('rm1', { maxCount: 5 }).then(() => {
        expect(storage.dropCollection).not.toHaveBeenCalled();
      });
    });

    test('deletes backups exceeding maxAge', () => {
      const now = Date.now();
      const backups = [
        {
          backupId: 'b2',
          timestamp: now,
          collections: ['items'],
          readModelName: 'rm1',
        },
        {
          backupId: 'b1',
          timestamp: now - 25 * 60 * 60 * 1000,
          collections: ['items'],
          readModelName: 'rm1',
        },
      ];
      const mockCursor = {
        sort: vi.fn().mockReturnThis(),
        toArray: vi.fn().mockResolvedValue(backups),
      };
      const storage = {
        dropCollection: vi.fn().mockResolvedValue(),
        perRequest: vi.fn().mockReturnValue({
          find: vi.fn().mockReturnValue(mockCursor),
          deleteOne: vi.fn().mockResolvedValue(),
        }),
      };
      const backup = mongoBackup()(storage);

      return backup.cleanupBackups('rm1', { maxAge: '1d' }).then(() => {
        expect(storage.dropCollection).toHaveBeenCalledOnce();
        expect(storage.dropCollection).toHaveBeenCalledWith(
          'cleanup',
          'b1_items',
        );
      });
    });
  });

  describe('custom metadataCollection', () => {
    test('uses custom metadata collection name', () => {
      const findCursor = {
        toArray: vi.fn().mockResolvedValue([]),
      };
      const storage = {
        copyCollection: vi.fn().mockResolvedValue(),
        perRequest: vi.fn().mockReturnValue({
          insertOne: vi.fn().mockResolvedValue({ acknowledged: true }),
          find: vi.fn().mockReturnValue(findCursor),
        }),
      };
      const backup = mongoBackup({
        metadataCollection: 'custom.backups',
      })(storage);

      return backup.createBackup('corr-1', 'rm1', ['items']).then(() => {
        const insertOne = storage.perRequest('corr-1').insertOne;
        expect(insertOne.mock.calls[0][0]).toBe('custom.backups');
      });
    });
  });
});
