import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const { createKeyCache } = await import('../keyCache.js');

describe('createKeyCache', () => {
  let mockKeyStore;
  let cached;

  beforeEach(() => {
    vi.clearAllMocks();
    mockKeyStore = {
      getDEK: vi.fn(),
      wrapDEK: vi.fn(),
      unwrapDEK: vi.fn(),
      storeDEK: vi.fn(),
      deleteKeysForSubject: vi.fn().mockResolvedValue(),
      close: vi.fn(),
    };
    cached = createKeyCache(mockKeyStore, {
      maxSize: 3,
      ttlMs: 60000,
    });
  });

  test('delegates non-overridden methods to keyStore', () => {
    expect(cached.wrapDEK).toBe(mockKeyStore.wrapDEK);
    expect(cached.unwrapDEK).toBe(mockKeyStore.unwrapDEK);
    expect(cached.storeDEK).toBe(mockKeyStore.storeDEK);
    expect(cached.close).toBe(mockKeyStore.close);
  });

  describe('getDEK', () => {
    test('delegates to keyStore on cache miss', () => {
      const dek = { wrappedKey: 'w', version: 1 };
      mockKeyStore.getDEK.mockResolvedValue(dek);

      return cached.getDEK('s1', 'personal').then((result) => {
        expect(result).toBe(dek);
        expect(mockKeyStore.getDEK).toHaveBeenCalledOnce();
      });
    });

    test('returns cached value on cache hit', () => {
      const dek = { wrappedKey: 'w', version: 1 };
      mockKeyStore.getDEK.mockResolvedValue(dek);

      return cached
        .getDEK('s1', 'personal')
        .then(() => cached.getDEK('s1', 'personal'))
        .then((result) => {
          expect(result).toBe(dek);
          // Only called once — second call hit cache
          expect(mockKeyStore.getDEK).toHaveBeenCalledOnce();
        });
    });

    test('does not cache null results', () => {
      mockKeyStore.getDEK.mockResolvedValue(null);

      return cached
        .getDEK('s1', 'personal')
        .then(() => cached.getDEK('s1', 'personal'))
        .then(() => {
          expect(mockKeyStore.getDEK).toHaveBeenCalledTimes(2);
        });
    });

    test('expires entries after TTL', () => {
      vi.useFakeTimers();
      const shortCached = createKeyCache(mockKeyStore, {
        maxSize: 100,
        ttlMs: 1000,
      });
      const dek = { wrappedKey: 'w', version: 1 };
      mockKeyStore.getDEK.mockResolvedValue(dek);

      return shortCached
        .getDEK('s1', 'personal')
        .then(() => {
          mockKeyStore.getDEK.mockClear();
          // Advance past TTL
          vi.advanceTimersByTime(1500);
          return shortCached.getDEK('s1', 'personal');
        })
        .then(() => {
          // Should have called the store again after TTL expired
          expect(mockKeyStore.getDEK).toHaveBeenCalledOnce();
          vi.useRealTimers();
        });
    });

    test('evicts LRU when cache is full', () => {
      mockKeyStore.getDEK.mockImplementation((subjectId) =>
        Promise.resolve({
          wrappedKey: `w-${subjectId}`,
          version: 1,
        }),
      );

      return cached
        .getDEK('s1', 'ctx')
        .then(() => cached.getDEK('s2', 'ctx'))
        .then(() => cached.getDEK('s3', 'ctx'))
        .then(() => cached.getDEK('s4', 'ctx'))
        .then(() => {
          // s1 should have been evicted (maxSize=3)
          mockKeyStore.getDEK.mockClear();
          return cached.getDEK('s1', 'ctx');
        })
        .then(() => {
          // s1 was evicted, so it should hit the store again
          expect(mockKeyStore.getDEK).toHaveBeenCalledOnce();
        });
    });
  });

  describe('deleteKeysForSubject', () => {
    test('evicts cache entries and delegates to keyStore', () => {
      const dek = { wrappedKey: 'w', version: 1 };
      mockKeyStore.getDEK.mockResolvedValue(dek);

      return cached
        .getDEK('s1', 'personal')
        .then(() => cached.deleteKeysForSubject('s1'))
        .then(() => {
          expect(mockKeyStore.deleteKeysForSubject).toHaveBeenCalledWith('s1');

          // After deletion, should hit store again
          mockKeyStore.getDEK.mockClear();
          return cached.getDEK('s1', 'personal');
        })
        .then(() => {
          expect(mockKeyStore.getDEK).toHaveBeenCalledOnce();
        });
    });

    test('does not delete entries for subjects that share a prefix', () => {
      mockKeyStore.getDEK.mockImplementation((subjectId) =>
        Promise.resolve({
          wrappedKey: `w-${subjectId}`,
          version: 1,
        }),
      );

      return cached
        .getDEK('cust', 'ctx')
        .then(() => cached.getDEK('cust-1', 'ctx'))
        .then(() => cached.deleteKeysForSubject('cust'))
        .then(() => {
          mockKeyStore.getDEK.mockClear();
          // cust-1 should still be cached (not evicted by deleting "cust")
          return cached.getDEK('cust-1', 'ctx');
        })
        .then(() => {
          expect(mockKeyStore.getDEK).not.toHaveBeenCalled();
        });
    });
  });

  describe('edge cases', () => {
    test('handles subjectId containing colon character', () => {
      mockKeyStore.getDEK.mockImplementation((subjectId) =>
        Promise.resolve({
          wrappedKey: `w-${subjectId}`,
          version: 1,
        }),
      );

      return cached
        .getDEK('urn:uuid:123', 'ctx')
        .then(() => cached.getDEK('urn:uuid:456', 'ctx'))
        .then(() => {
          mockKeyStore.getDEK.mockClear();
          // Should still be cached
          return cached.getDEK('urn:uuid:123', 'ctx');
        })
        .then((result) => {
          expect(result.wrappedKey).toBe('w-urn:uuid:123');
          expect(mockKeyStore.getDEK).not.toHaveBeenCalled();
        });
    });

    test('LRU access reordering keeps recently accessed entries', () => {
      mockKeyStore.getDEK.mockImplementation((subjectId) =>
        Promise.resolve({
          wrappedKey: `w-${subjectId}`,
          version: 1,
        }),
      );

      // Fill cache (maxSize=3): s1, s2, s3
      return cached
        .getDEK('s1', 'ctx')
        .then(() => cached.getDEK('s2', 'ctx'))
        .then(() => cached.getDEK('s3', 'ctx'))
        .then(() => {
          // Access s1 to move it to most-recently-used
          return cached.getDEK('s1', 'ctx');
        })
        .then(() => {
          // Add s4 — should evict s2 (oldest untouched), not s1
          return cached.getDEK('s4', 'ctx');
        })
        .then(() => {
          mockKeyStore.getDEK.mockClear();
          // s1 should still be cached (it was accessed recently)
          return cached.getDEK('s1', 'ctx');
        })
        .then(() => {
          expect(mockKeyStore.getDEK).not.toHaveBeenCalled();
          // s2 should have been evicted
          return cached.getDEK('s2', 'ctx');
        })
        .then(() => {
          expect(mockKeyStore.getDEK).toHaveBeenCalledOnce();
        });
    });
  });
});
