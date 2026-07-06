import { describe, test, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  filesystemTimestampStorage,
  readTimestampFromBoth,
} from '../secondaryTimestampStorage.js';

describe('filesystemTimestampStorage', () => {
  let basePath;
  let storage;

  beforeEach(() =>
    mkdtemp(join(tmpdir(), 'ts-test-')).then((dir) => {
      basePath = dir;
      storage = filesystemTimestampStorage(basePath);
    }),
  );

  test('writeTimestamp creates file with timestamp value', () =>
    storage
      .writeTimestamp('myRM', 42000)
      .then(() => readFile(join(basePath, 'myRM.timestamp'), 'utf8'))
      .then((content) => {
        expect(content).toBe('42000');
      }));

  test('readTimestamp reads back the written value', () =>
    storage
      .writeTimestamp('myRM', 98765)
      .then(() => storage.readTimestamp('myRM'))
      .then((ts) => {
        expect(ts).toBe(98765);
      }));

  test('readTimestamp returns 0 for missing file', () =>
    storage.readTimestamp('nonexistent').then((ts) => {
      expect(ts).toBe(0);
    }));

  test('readTimestamp returns 0 for corrupt file', () =>
    writeFile(join(basePath, 'corrupt.timestamp'), 'not-a-number', 'utf8')
      .then(() => storage.readTimestamp('corrupt'))
      .then((ts) => {
        expect(ts).toBe(0);
      }));
});

describe('readTimestampFromBoth', () => {
  const makeReadModels = (timestamps) => {
    const rms = {};
    Object.entries(timestamps).forEach(([name, ts]) => {
      rms[name] = { lastProjectedEventTimestamp: ts };
    });
    return rms;
  };

  test('uses the larger of primary and secondary values', () => {
    const readModels = makeReadModels({ alpha: 0, beta: 0 });

    const primaryStorage = {
      readLastProjectedEventTimestamps: vi.fn((rms) => {
        rms.alpha.lastProjectedEventTimestamp = 100;
        rms.beta.lastProjectedEventTimestamp = 500;
        return Promise.resolve();
      }),
    };

    const secondaryStorage = {
      readTimestamp: vi.fn((name) => {
        if (name === 'alpha') return Promise.resolve(300);
        if (name === 'beta') return Promise.resolve(200);
        return Promise.resolve(0);
      }),
    };

    return readTimestampFromBoth(
      primaryStorage,
      secondaryStorage,
    )(readModels).then(() => {
      // alpha: secondary (300) > primary (100), use secondary
      expect(readModels.alpha.lastProjectedEventTimestamp).toBe(300);
      // beta: primary (500) > secondary (200), keep primary
      expect(readModels.beta.lastProjectedEventTimestamp).toBe(500);
    });
  });

  test('works when secondaryStorage is null (primary only)', () => {
    const readModels = makeReadModels({ alpha: 0 });

    const primaryStorage = {
      readLastProjectedEventTimestamps: vi.fn((rms) => {
        rms.alpha.lastProjectedEventTimestamp = 100;
        return Promise.resolve();
      }),
    };

    return readTimestampFromBoth(
      primaryStorage,
      null,
    )(readModels).then(() => {
      expect(readModels.alpha.lastProjectedEventTimestamp).toBe(100);
    });
  });

  test('handles secondary read failure gracefully (keeps primary)', () => {
    const readModels = makeReadModels({ alpha: 0 });

    const primaryStorage = {
      readLastProjectedEventTimestamps: vi.fn((rms) => {
        rms.alpha.lastProjectedEventTimestamp = 100;
        return Promise.resolve();
      }),
    };

    const secondaryStorage = {
      readTimestamp: vi.fn(() => Promise.resolve(0)),
    };

    return readTimestampFromBoth(
      primaryStorage,
      secondaryStorage,
    )(readModels).then(() => {
      // secondary returns 0 (its fallback), primary stays
      expect(readModels.alpha.lastProjectedEventTimestamp).toBe(100);
    });
  });
});
