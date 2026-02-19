import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  }),
}));

const { createBackupScheduler, __testing__ } =
  await import('../backupScheduler.js');

describe('backupScheduler', () => {
  describe('parseInterval', () => {
    test('parses hours', () => {
      expect(__testing__.parseInterval('6h')).toBe(6 * 60 * 60 * 1000);
    });

    test('parses days', () => {
      expect(__testing__.parseInterval('2d')).toBe(2 * 24 * 60 * 60 * 1000);
    });

    test('parses minutes', () => {
      expect(__testing__.parseInterval('15m')).toBe(15 * 60 * 1000);
    });

    test('returns 0 for invalid', () => {
      expect(__testing__.parseInterval('bad')).toBe(0);
    });
  });

  describe('createBackupScheduler', () => {
    let context;
    let scheduler;

    beforeEach(() => {
      vi.useFakeTimers();
      context = {
        readModels: {
          customers: { collections: ['items', 'orders'] },
          products: {},
        },
        backup: {
          createBackup: vi.fn().mockResolvedValue({ backupId: 'b1' }),
          cleanupBackups: vi.fn().mockResolvedValue(),
        },
      };
    });

    afterEach(() => {
      if (scheduler) scheduler.stop();
      vi.useRealTimers();
    });

    test('returns start, stop, and runBackups', () => {
      scheduler = createBackupScheduler(context, {
        interval: '1h',
        readModels: ['customers'],
      });
      expect(typeof scheduler.start).toBe('function');
      expect(typeof scheduler.stop).toBe('function');
      expect(typeof scheduler.runBackups).toBe('function');
    });

    test('runBackups creates backups for specified read models', () => {
      scheduler = createBackupScheduler(context, {
        interval: '1h',
        readModels: ['customers'],
      });

      return scheduler.runBackups().then(() => {
        expect(context.backup.createBackup).toHaveBeenCalledOnce();
        expect(context.backup.createBackup).toHaveBeenCalledWith(
          'backup-sched',
          'customers',
          ['items', 'orders'],
        );
      });
    });

    test('runBackups uses readModelName as default collection when collections not specified', () => {
      scheduler = createBackupScheduler(context, {
        interval: '1h',
        readModels: ['products'],
      });

      return scheduler.runBackups().then(() => {
        expect(context.backup.createBackup).toHaveBeenCalledWith(
          'backup-sched',
          'products',
          ['products'],
        );
      });
    });

    test('runBackups backs up all read models when no targets specified', () => {
      scheduler = createBackupScheduler(context, {
        interval: '1h',
      });

      return scheduler.runBackups().then(() => {
        expect(context.backup.createBackup).toHaveBeenCalledTimes(2);
      });
    });

    test('runBackups runs cleanup when retention policy is set', () => {
      scheduler = createBackupScheduler(context, {
        interval: '1h',
        retention: { maxCount: 5 },
        readModels: ['customers'],
      });

      return scheduler.runBackups().then(() => {
        expect(context.backup.cleanupBackups).toHaveBeenCalledWith(
          'customers',
          { maxCount: 5 },
        );
      });
    });

    test('runBackups skips cleanup when no retention policy', () => {
      scheduler = createBackupScheduler(context, {
        interval: '1h',
        readModels: ['customers'],
      });

      return scheduler.runBackups().then(() => {
        expect(context.backup.cleanupBackups).not.toHaveBeenCalled();
      });
    });

    test('start sets up interval timer', () => {
      scheduler = createBackupScheduler(context, {
        interval: '1h',
        readModels: ['customers'],
      });

      scheduler.start();
      return vi.advanceTimersByTimeAsync(60 * 60 * 1000).then(() => {
        expect(context.backup.createBackup).toHaveBeenCalledOnce();
      });
    });

    test('stop clears interval timer', () => {
      scheduler = createBackupScheduler(context, {
        interval: '1h',
        readModels: ['customers'],
      });

      scheduler.start();
      scheduler.stop();
      return vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000).then(() => {
        expect(context.backup.createBackup).not.toHaveBeenCalled();
      });
    });

    test('continues if individual backup fails', () => {
      context.backup.createBackup = vi
        .fn()
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValueOnce({ backupId: 'b2' });

      scheduler = createBackupScheduler(context, {
        interval: '1h',
        readModels: ['customers', 'products'],
      });

      return scheduler.runBackups().then(() => {
        expect(context.backup.createBackup).toHaveBeenCalledTimes(2);
      });
    });
  });
});
