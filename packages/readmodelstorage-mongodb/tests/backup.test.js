import { describe, test, expect, vi } from 'vitest';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { backup, __testing__ } = await import('../backup.js');
const { formatTimestamp, generateBackupId, parseMaxAge } = __testing__;

describe('formatTimestamp', () => {
  test('replaces colons with hyphens in ISO string', () => {
    const ts = new Date('2026-03-06T14:30:00.000Z').getTime();
    expect(formatTimestamp(ts)).toBe('2026-03-06T14-30-00.000Z');
  });

  test('handles midnight correctly', () => {
    const ts = new Date('2026-01-01T00:00:00.000Z').getTime();
    expect(formatTimestamp(ts)).toBe('2026-01-01T00-00-00.000Z');
  });
});

describe('generateBackupId', () => {
  test('produces readModelName__timestamp format', () => {
    const ts = new Date('2026-03-06T14:30:00.000Z').getTime();
    const id = generateBackupId('customers', ts);
    expect(id).toBe('customers__2026-03-06T14-30-00.000Z');
  });

  test('handles read model names with special characters', () => {
    const ts = new Date('2026-03-06T14:30:00.000Z').getTime();
    const id = generateBackupId('customers-overview', ts);
    expect(id).toBe('customers-overview__2026-03-06T14-30-00.000Z');
  });
});

describe('parseMaxAge', () => {
  test('parses days', () => {
    expect(parseMaxAge('7d')).toBe(7 * 24 * 60 * 60 * 1000);
  });

  test('parses hours', () => {
    expect(parseMaxAge('12h')).toBe(12 * 60 * 60 * 1000);
  });

  test('parses minutes', () => {
    expect(parseMaxAge('30m')).toBe(30 * 60 * 1000);
  });

  test('returns 0 for invalid format', () => {
    expect(parseMaxAge('invalid')).toBe(0);
  });

  test('returns 0 for empty string', () => {
    expect(parseMaxAge('')).toBe(0);
  });
});

describe('backup factory', () => {
  test('is a curried function', () => {
    expect(typeof backup).toBe('function');
    const configured = backup({ backupPath: '/tmp/test' });
    expect(typeof configured).toBe('function');
  });

  test('returns an object with all backup methods', () => {
    const storage = {
      __connectionInfo__: {
        url: 'mongodb://localhost:27017',
        database: 'test',
      },
    };
    const instance = backup({ backupPath: '/tmp/test' })(storage);
    expect(typeof instance.createBackup).toBe('function');
    expect(typeof instance.listBackups).toBe('function');
    expect(typeof instance.restoreBackup).toBe('function');
    expect(typeof instance.deleteBackup).toBe('function');
    expect(typeof instance.clearCollections).toBe('function');
    expect(typeof instance.cleanupBackups).toBe('function');
  });
});
