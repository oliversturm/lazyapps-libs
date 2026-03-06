import { describe, test, expect, vi, beforeEach } from 'vitest';
import { randomBytes, createHmac, createDecipheriv } from 'node:crypto';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

const createMockCollection = () => {
  const docs = [];
  return {
    __docs: docs,
    insertOne: vi.fn((doc) => {
      docs.push(doc);
      return Promise.resolve({ insertedId: 'mock-id' });
    }),
    findOne: vi.fn((filter, options) => {
      const matches = docs.filter(
        (d) =>
          d.subjectId === filter.subjectId &&
          d.context === filter.context &&
          (filter.version === undefined || d.version === filter.version),
      );
      if (matches.length === 0) return Promise.resolve(null);
      if (options?.sort?.version === -1) {
        matches.sort((a, b) => b.version - a.version);
      }
      return Promise.resolve(matches[0]);
    }),
    find: vi.fn((filter) => ({
      toArray: () =>
        Promise.resolve(docs.filter((d) => d.context === filter.context)),
    })),
    deleteMany: vi.fn((filter) => {
      const before = docs.length;
      const remaining = docs.filter((d) => d.subjectId !== filter.subjectId);
      docs.length = 0;
      docs.push(...remaining);
      return Promise.resolve({ deletedCount: before - remaining.length });
    }),
  };
};

const createForgottenCollection = () => {
  const docs = [];
  return {
    __docs: docs,
    findOne: vi.fn((filter) => {
      const match = docs.find((d) => d.subjectId === filter.subjectId);
      return Promise.resolve(match || null);
    }),
    updateOne: vi.fn((filter, update, options) => {
      const existing = docs.find((d) => d.subjectId === filter.subjectId);
      if (!existing) {
        docs.push(update.$set);
      }
      return Promise.resolve({ upsertedCount: existing ? 0 : 1 });
    }),
  };
};

const createMockClient = (collection, forgottenCol) => ({
  db: vi.fn(() => ({
    collection: vi.fn((name) =>
      name.endsWith('-forgotten') ? forgottenCol : collection,
    ),
  })),
  close: vi.fn(() => Promise.resolve()),
});

vi.mock('mongodb', () => {
  let mockClient;
  return {
    MongoClient: {
      connect: vi.fn(() => Promise.resolve(mockClient)),
    },
    __setMockClient: (client) => {
      mockClient = client;
    },
  };
});

const { MongoClient, __setMockClient } = await import('mongodb');
const { mongoKeyStore } = await import('../keystores/mongo.js');

describe('mongoKeyStore', () => {
  const rootSecret = randomBytes(32);
  let mockCollection;
  let mockForgottenCollection;
  let mockClient;
  let ks;

  beforeEach(() => {
    mockCollection = createMockCollection();
    mockForgottenCollection = createForgottenCollection();
    mockClient = createMockClient(mockCollection, mockForgottenCollection);
    __setMockClient(mockClient);

    return mongoKeyStore({
      url: 'mongodb://localhost:27017',
      rootSecret,
      database: 'test-keys',
      dekCollection: 'test-deks',
    })
      .initialize()
      .then((store) => {
        ks = store;
      });
  });

  describe('initialize', () => {
    test('connects to MongoDB', () => {
      expect(MongoClient.connect).toHaveBeenCalledWith(
        'mongodb://localhost:27017',
      );
    });

    test('returns key store interface', () => {
      expect(ks).toHaveProperty('wrapDEK');
      expect(ks).toHaveProperty('unwrapDEK');
      expect(ks).toHaveProperty('getDEK');
      expect(ks).toHaveProperty('storeDEK');
      expect(ks).toHaveProperty('getAllDEKsForContext');
      expect(ks).toHaveProperty('deleteKeysForSubject');
      expect(ks).toHaveProperty('close');
    });

    test('uses default database and collection names', () =>
      mongoKeyStore({
        url: 'mongodb://localhost:27017',
        rootSecret,
      })
        .initialize()
        .then(() => {
          expect(mockClient.db).toHaveBeenCalledWith('encryption-keys');
        }));

    test('accepts base64 string rootSecret', () =>
      mongoKeyStore({
        url: 'mongodb://localhost:27017',
        rootSecret: rootSecret.toString('base64'),
      })
        .initialize()
        .then((store) => {
          const dek = randomBytes(32);
          return store
            .wrapDEK('personal', dek)
            .then((wrapped) => store.unwrapDEK('personal', wrapped))
            .then((unwrapped) => {
              expect(Buffer.compare(unwrapped, dek)).toBe(0);
            });
        }));
  });

  describe('deriveKEK consistency', () => {
    test('derives same KEK for same context', () => {
      const dek = randomBytes(32);
      return ks
        .wrapDEK('personal', dek)
        .then((wrapped) => ks.unwrapDEK('personal', wrapped))
        .then((unwrapped) => {
          expect(Buffer.compare(unwrapped, dek)).toBe(0);
        });
    });

    test('derives different KEKs for different contexts', () => {
      const dek = randomBytes(32);
      return ks
        .wrapDEK('personal', dek)
        .then((wrapped) => ks.unwrapDEK('financial', wrapped))
        .then(
          () => {
            throw new Error('should have thrown');
          },
          () => {
            // Expected: unwrap fails with wrong KEK
          },
        );
    });

    test('HMAC-SHA256 derivation matches manual computation', () => {
      const dek = randomBytes(32);
      const hmac = createHmac('sha256', rootSecret);
      hmac.update('personal');
      const expectedKEK = hmac.digest();

      return ks.wrapDEK('personal', dek).then((wrapped) => {
        // Manually unwrap using the expected KEK to verify derivation
        const decipher = createDecipheriv(
          'aes-256-gcm',
          expectedKEK,
          Buffer.from(wrapped.iv, 'base64'),
        );
        decipher.setAuthTag(Buffer.from(wrapped.tag, 'base64'));
        const unwrapped = Buffer.concat([
          decipher.update(Buffer.from(wrapped.data, 'base64')),
          decipher.final(),
        ]);
        expect(Buffer.compare(unwrapped, dek)).toBe(0);
      });
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

    test('produces different ciphertexts for same input (random IV)', () => {
      const dek = randomBytes(32);
      return Promise.all([
        ks.wrapDEK('personal', dek),
        ks.wrapDEK('personal', dek),
      ]).then(([w1, w2]) => {
        expect(w1.iv).not.toBe(w2.iv);
      });
    });

    test('wrapped DEK has iv, data, and tag fields', () => {
      const dek = randomBytes(32);
      return ks.wrapDEK('personal', dek).then((wrapped) => {
        expect(wrapped).toHaveProperty('iv');
        expect(wrapped).toHaveProperty('data');
        expect(wrapped).toHaveProperty('tag');
      });
    });
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

    test('stores document with correct fields', () => {
      const dekInfo = {
        wrappedKey: { iv: 'iv-val', data: 'data-val', tag: 'tag-val' },
        version: 3,
      };
      return ks.storeDEK('sub-1', 'ctx', dekInfo).then(() => {
        expect(mockCollection.insertOne).toHaveBeenCalledWith(
          expect.objectContaining({
            subjectId: 'sub-1',
            context: 'ctx',
            version: 3,
            iv: 'iv-val',
            data: 'data-val',
            tag: 'tag-val',
            createdAt: expect.any(Number),
          }),
        );
      });
    });

    test('getDEK with version parameter filters by version', () =>
      ks
        .storeDEK('sub-1', 'personal', {
          wrappedKey: { iv: '1', data: '1', tag: '1' },
          version: 1,
        })
        .then(() =>
          ks.storeDEK('sub-1', 'personal', {
            wrappedKey: { iv: '2', data: '2', tag: '2' },
            version: 2,
          }),
        )
        .then(() => ks.getDEK('sub-1', 'personal', 1))
        .then((result) => {
          expect(result.version).toBe(1);
          expect(mockCollection.findOne).toHaveBeenCalledWith(
            { subjectId: 'sub-1', context: 'personal', version: 1 },
            { sort: { version: -1 } },
          );
        }));

    test('getDEK without version returns latest (highest version)', () =>
      ks
        .storeDEK('sub-1', 'personal', {
          wrappedKey: { iv: '1', data: '1', tag: '1' },
          version: 1,
        })
        .then(() =>
          ks.storeDEK('sub-1', 'personal', {
            wrappedKey: { iv: '2', data: '2', tag: '2' },
            version: 2,
          }),
        )
        .then(() => ks.getDEK('sub-1', 'personal'))
        .then((result) => {
          expect(result.version).toBe(2);
        }));
  });

  describe('getAllDEKsForContext', () => {
    test('returns all DEKs for a context', () =>
      ks
        .storeDEK('sub-1', 'personal', {
          wrappedKey: { iv: '1', data: '1', tag: '1' },
          version: 1,
        })
        .then(() =>
          ks.storeDEK('sub-2', 'personal', {
            wrappedKey: { iv: '2', data: '2', tag: '2' },
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

    test('maps MongoDB documents to key store format', () =>
      ks
        .storeDEK('sub-1', 'personal', {
          wrappedKey: { iv: 'iv-val', data: 'data-val', tag: 'tag-val' },
          version: 5,
        })
        .then(() => ks.getAllDEKsForContext('personal'))
        .then((results) => {
          expect(results[0]).toEqual({
            subjectId: 'sub-1',
            wrappedKey: { iv: 'iv-val', data: 'data-val', tag: 'tag-val' },
            version: 5,
          });
        }));
  });

  describe('deleteKeysForSubject', () => {
    test('removes all DEKs for a subject and marks as forgotten', () =>
      ks
        .storeDEK('sub-1', 'personal', {
          wrappedKey: { iv: '1', data: '1', tag: '1' },
          version: 1,
        })
        .then(() =>
          ks.storeDEK('sub-1', 'financial', {
            wrappedKey: { iv: '2', data: '2', tag: '2' },
            version: 1,
          }),
        )
        .then(() => ks.deleteKeysForSubject('sub-1'))
        .then(() => ks.getDEK('sub-1', 'personal'))
        .then((result) => {
          expect(result).toEqual({ forgotten: true });
        }));

    test('calls deleteMany with correct filter', () =>
      ks.deleteKeysForSubject('sub-1').then(() => {
        expect(mockCollection.deleteMany).toHaveBeenCalledWith({
          subjectId: 'sub-1',
        });
      }));

    test('does not affect other subjects', () =>
      ks
        .storeDEK('sub-1', 'personal', {
          wrappedKey: { iv: '1', data: '1', tag: '1' },
          version: 1,
        })
        .then(() =>
          ks.storeDEK('sub-2', 'personal', {
            wrappedKey: { iv: '2', data: '2', tag: '2' },
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
    test('closes the MongoDB client', () =>
      ks.close().then(() => {
        expect(mockClient.close).toHaveBeenCalled();
      }));
  });
});
