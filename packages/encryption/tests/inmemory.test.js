import { describe, test, expect, vi, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';

const { inMemoryKeyStore } = await import('../keystores/inmemory.js');

describe('inMemoryKeyStore', () => {
  const personalKEK = randomBytes(32);
  let ks;

  beforeEach(() =>
    inMemoryKeyStore({ personal: personalKEK })
      .initialize()
      .then((store) => {
        ks = store;
      }),
  );

  describe('initialize', () => {
    test('returns key store interface', () => {
      expect(ks).toHaveProperty('wrapDEK');
      expect(ks).toHaveProperty('unwrapDEK');
      expect(ks).toHaveProperty('getDEK');
      expect(ks).toHaveProperty('storeDEK');
      expect(ks).toHaveProperty('getAllDEKsForContext');
      expect(ks).toHaveProperty('deleteKeysForSubject');
      expect(ks).toHaveProperty('close');
    });
  });

  describe('wrapDEK / unwrapDEK', () => {
    test('round-trips a DEK', () => {
      const dek = randomBytes(32);
      return ks
        .wrapDEK('personal', dek)
        .then((wrapped) => ks.unwrapDEK('personal', wrapped))
        .then((unwrapped) => {
          expect(Buffer.compare(unwrapped, dek)).toBe(0);
        });
    });

    test('rejects for unknown context', () =>
      expect(ks.wrapDEK('unknown', randomBytes(32))).rejects.toThrow(
        'KEK not found: unknown',
      ));

    test('wrapDEK error has KEK_NOT_FOUND code', () =>
      ks.wrapDEK('unknown', randomBytes(32)).catch((err) => {
        expect(err.code).toBe('KEK_NOT_FOUND');
      }));

    test('unwrapDEK rejects for unknown context', () =>
      expect(
        ks.unwrapDEK('unknown', { iv: 'a', data: 'b', tag: 'c' }),
      ).rejects.toThrow('KEK not found: unknown'));

    test('unwrapDEK error has KEK_NOT_FOUND code', () =>
      ks.unwrapDEK('unknown', { iv: 'a', data: 'b', tag: 'c' }).catch((err) => {
        expect(err.code).toBe('KEK_NOT_FOUND');
      }));
  });

  describe('getDEK / storeDEK', () => {
    test('returns null for non-existent DEK', () =>
      ks.getDEK('sub-1', 'personal').then((result) => {
        expect(result).toBeNull();
      }));

    test('stores and retrieves a DEK', () => {
      const dekInfo = {
        wrappedKey: { iv: 'a', data: 'b', tag: 'c' },
        version: 1,
      };
      return ks
        .storeDEK('sub-1', 'personal', dekInfo)
        .then(() => ks.getDEK('sub-1', 'personal'))
        .then((result) => {
          expect(result.wrappedKey).toEqual(dekInfo.wrappedKey);
          expect(result.version).toBe(1);
        });
    });
  });

  describe('getAllDEKsForContext', () => {
    test('returns all DEKs for a context', () =>
      ks
        .storeDEK('sub-1', 'personal', {
          wrappedKey: { iv: '1' },
          version: 1,
        })
        .then(() =>
          ks.storeDEK('sub-2', 'personal', {
            wrappedKey: { iv: '2' },
            version: 1,
          }),
        )
        .then(() => ks.getAllDEKsForContext('personal'))
        .then((results) => {
          expect(results).toHaveLength(2);
          const subjects = results.map((r) => r.subjectId).sort();
          expect(subjects).toEqual(['sub-1', 'sub-2']);
        }));

    test('returns empty array for context with no DEKs', () =>
      ks.getAllDEKsForContext('nonexistent').then((results) => {
        expect(results).toEqual([]);
      }));

    test('returns only matching context, not others', () =>
      ks
        .storeDEK('sub-1', 'personal', {
          wrappedKey: { iv: '1' },
          version: 1,
        })
        .then(() =>
          ks.storeDEK('sub-1', 'financial', {
            wrappedKey: { iv: '2' },
            version: 1,
          }),
        )
        .then(() => ks.getAllDEKsForContext('personal'))
        .then((results) => {
          expect(results).toHaveLength(1);
          expect(results[0].subjectId).toBe('sub-1');
        }));
  });

  describe('deleteKeysForSubject', () => {
    test('removes all DEKs for a subject', () =>
      ks
        .storeDEK('sub-1', 'personal', {
          wrappedKey: { iv: '1' },
          version: 1,
        })
        .then(() =>
          ks.storeDEK('sub-1', 'financial', {
            wrappedKey: { iv: '2' },
            version: 1,
          }),
        )
        .then(() => ks.deleteKeysForSubject('sub-1'))
        .then(() => ks.getDEK('sub-1', 'personal'))
        .then((result) => {
          expect(result).toBeNull();
        }));

    test('does not affect other subjects', () =>
      ks
        .storeDEK('sub-1', 'personal', {
          wrappedKey: { iv: '1' },
          version: 1,
        })
        .then(() =>
          ks.storeDEK('sub-2', 'personal', {
            wrappedKey: { iv: '2' },
            version: 1,
          }),
        )
        .then(() => ks.deleteKeysForSubject('sub-1'))
        .then(() => ks.getDEK('sub-2', 'personal'))
        .then((result) => {
          expect(result).not.toBeNull();
        }));
  });

  describe('close', () => {
    test('resolves without error', () =>
      expect(ks.close()).resolves.toBeUndefined());
  });

  describe('base64 KEK input', () => {
    test('accepts base64 string KEKs', () => {
      const kek = randomBytes(32);
      return inMemoryKeyStore({ personal: kek.toString('base64') })
        .initialize()
        .then((store) => {
          const dek = randomBytes(32);
          return store
            .wrapDEK('personal', dek)
            .then((wrapped) => store.unwrapDEK('personal', wrapped))
            .then((unwrapped) => {
              expect(Buffer.compare(unwrapped, dek)).toBe(0);
            });
        });
    });
  });
});
