import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

const { appRole, vaultKeyStore } = await import('../keystores/vault.js');

const VAULT_URL = 'http://vault:8200';
const VAULT_TOKEN = 'test-token';

const createFetchMock = (handlers) => {
  const calls = [];
  return {
    calls,
    fn: vi.fn((url, options) => {
      calls.push({ url, options });
      const handler = handlers.find((h) => url.includes(h.path));
      if (!handler) {
        return Promise.resolve({
          ok: false,
          status: 404,
          statusText: 'Not Found',
          json: () => Promise.resolve({ errors: ['not found'] }),
        });
      }
      const body = options?.body ? JSON.parse(options.body) : undefined;
      return Promise.resolve(handler.respond(body, options));
    }),
  };
};

const okResponse = (data) => ({
  ok: true,
  status: 200,
  json: () => Promise.resolve(data),
});

const errorResponse = (status, errors) => ({
  ok: false,
  status,
  statusText: `Error ${status}`,
  json: () => Promise.resolve({ errors }),
});

describe('vaultKeyStore', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('appRole helper', () => {
    test('returns roleId and secretId', () => {
      const result = appRole({ roleId: 'r-1', secretId: 's-1' });
      expect(result).toEqual({ roleId: 'r-1', secretId: 's-1' });
    });
  });

  describe('token-based auth', () => {
    let ks;

    beforeEach(() => {
      const mock = createFetchMock([
        {
          path: 'transit/encrypt/',
          respond: (body) =>
            okResponse({
              data: {
                ciphertext: `vault:v1:${Buffer.from(body.plaintext, 'base64').toString('base64')}`,
              },
            }),
        },
        {
          path: 'transit/decrypt/',
          respond: (body) => {
            const ct = body.ciphertext.split(':')[2];
            return okResponse({ data: { plaintext: ct } });
          },
        },
        {
          path: 'transit/keys/',
          respond: () => okResponse({}),
        },
      ]);
      globalThis.fetch = mock.fn;

      return vaultKeyStore({
        vaultUrl: VAULT_URL,
        token: VAULT_TOKEN,
      })
        .initialize()
        .then((store) => {
          ks = store;
        });
    });

    test('returns key store interface', () => {
      expect(ks).toHaveProperty('wrapDEK');
      expect(ks).toHaveProperty('unwrapDEK');
      expect(ks).toHaveProperty('getDEK');
      expect(ks).toHaveProperty('storeDEK');
      expect(ks).toHaveProperty('getAllDEKsForContext');
      expect(ks).toHaveProperty('deleteKeysForSubjectContext');
      expect(ks).toHaveProperty('deleteKeysForSubject');
      expect(ks).toHaveProperty('rotateKEK');
      expect(ks).toHaveProperty('close');
    });

    test('does not call auth/approle/login with token auth', () => {
      const authCalls = globalThis.fetch.mock.calls.filter(([url]) =>
        url.includes('approle'),
      );
      expect(authCalls).toHaveLength(0);
    });

    describe('wrapDEK / unwrapDEK', () => {
      test('calls transit encrypt endpoint', () => {
        const dek = randomBytes(32);
        return ks.wrapDEK('personal', dek).then((ciphertext) => {
          expect(typeof ciphertext).toBe('string');
          expect(ciphertext.startsWith('vault:v1:')).toBe(true);
          const encryptCall = globalThis.fetch.mock.calls.find(([url]) =>
            url.includes('transit/encrypt/personal'),
          );
          expect(encryptCall).toBeDefined();
          const body = JSON.parse(encryptCall[1].body);
          expect(body.plaintext).toBe(dek.toString('base64'));
        });
      });

      test('calls transit decrypt endpoint', () => {
        const dek = randomBytes(32);
        return ks
          .wrapDEK('personal', dek)
          .then((ciphertext) => ks.unwrapDEK('personal', ciphertext))
          .then((unwrapped) => {
            expect(Buffer.isBuffer(unwrapped)).toBe(true);
            expect(Buffer.compare(unwrapped, dek)).toBe(0);
          });
      });

      test('sends correct headers', () => {
        const dek = randomBytes(32);
        return ks.wrapDEK('personal', dek).then(() => {
          const call = globalThis.fetch.mock.calls.find(([url]) =>
            url.includes('transit/encrypt'),
          );
          expect(call[1].headers['X-Vault-Token']).toBe(VAULT_TOKEN);
          expect(call[1].headers['Content-Type']).toBe('application/json');
        });
      });
    });

    describe('rotateKEK', () => {
      test('calls transit key rotate endpoint', () =>
        ks.rotateKEK('personal').then(() => {
          const rotateCall = globalThis.fetch.mock.calls.find(([url]) =>
            url.includes('transit/keys/personal/rotate'),
          );
          expect(rotateCall).toBeDefined();
          expect(rotateCall[1].method).toBe('POST');
        }));
    });

    describe('DEK storage (in-memory backend)', () => {
      test('returns null for non-existent DEK', () =>
        ks.getDEK('sub-1', 'personal').then((result) => {
          expect(result).toBeNull();
        }));

      test('stores and retrieves a DEK', () => {
        const dekInfo = {
          wrappedKey: 'vault:v1:encrypted-data',
          version: 1,
        };
        return ks
          .storeDEK('sub-1', 'personal', dekInfo)
          .then(() => ks.getDEK('sub-1', 'personal'))
          .then((result) => {
            expect(result.wrappedKey).toBe('vault:v1:encrypted-data');
            expect(result.version).toBe(1);
          });
      });

      test('getAllDEKsForContext returns matching DEKs', () =>
        ks
          .storeDEK('sub-1', 'personal', {
            wrappedKey: 'ct-1',
            version: 1,
          })
          .then(() =>
            ks.storeDEK('sub-2', 'personal', {
              wrappedKey: 'ct-2',
              version: 1,
            }),
          )
          .then(() => ks.getAllDEKsForContext('personal'))
          .then((results) => {
            expect(results).toHaveLength(2);
            const subjects = results.map((r) => r.subjectId).sort();
            expect(subjects).toEqual(['sub-1', 'sub-2']);
          }));

      test('getAllDEKsForContext returns empty for unknown context', () =>
        ks.getAllDEKsForContext('nonexistent').then((results) => {
          expect(results).toEqual([]);
        }));

      test('deleteKeysForSubjectContext removes only specified context', () =>
        ks
          .storeDEK('sub-1', 'personal', {
            wrappedKey: 'ct-1',
            version: 1,
          })
          .then(() =>
            ks.storeDEK('sub-1', 'financial', {
              wrappedKey: 'ct-2',
              version: 1,
            }),
          )
          .then(() => ks.deleteKeysForSubjectContext('sub-1', 'personal'))
          .then(() => ks.getDEK('sub-1', 'personal'))
          .then((result) => {
            expect(result).toEqual({ forgotten: true });
            return ks.getDEK('sub-1', 'financial');
          })
          .then((result) => {
            expect(result).not.toBeNull();
            expect(result.wrappedKey).toBe('ct-2');
          }));

      test('deleteKeysForSubject removes all DEKs and marks subject as forgotten', () =>
        ks
          .storeDEK('sub-1', 'personal', {
            wrappedKey: 'ct-1',
            version: 1,
          })
          .then(() =>
            ks.storeDEK('sub-1', 'financial', {
              wrappedKey: 'ct-2',
              version: 1,
            }),
          )
          .then(() => ks.deleteKeysForSubject('sub-1'))
          .then(() => ks.getDEK('sub-1', 'personal'))
          .then((result) => {
            expect(result).toEqual({ forgotten: true });
          }));

      test('deleteKeysForSubject does not affect other subjects', () =>
        ks
          .storeDEK('sub-1', 'personal', {
            wrappedKey: 'ct-1',
            version: 1,
          })
          .then(() =>
            ks.storeDEK('sub-2', 'personal', {
              wrappedKey: 'ct-2',
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
  });

  describe('AppRole authentication', () => {
    test('authenticates via AppRole before making requests', () => {
      const appRoleToken = 'approle-generated-token';
      const mock = createFetchMock([
        {
          path: 'auth/approle/login',
          respond: () => okResponse({ auth: { client_token: appRoleToken } }),
        },
        {
          path: 'transit/encrypt/',
          respond: (body) =>
            okResponse({ data: { ciphertext: 'vault:v1:ct' } }),
        },
      ]);
      globalThis.fetch = mock.fn;

      return vaultKeyStore({
        vaultUrl: VAULT_URL,
        authMethod: appRole({ roleId: 'role-1', secretId: 'secret-1' }),
      })
        .initialize()
        .then((ks) => {
          const loginCall = mock.calls.find((c) =>
            c.url.includes('approle/login'),
          );
          expect(loginCall).toBeDefined();
          const loginBody = JSON.parse(loginCall.options.body);
          expect(loginBody.role_id).toBe('role-1');
          expect(loginBody.secret_id).toBe('secret-1');

          return ks.wrapDEK('ctx', randomBytes(32)).then(() => {
            const transitCall = mock.calls.find((c) =>
              c.url.includes('transit/encrypt'),
            );
            expect(transitCall.options.headers['X-Vault-Token']).toBe(
              appRoleToken,
            );
          });
        });
    });
  });

  describe('Vault API error handling', () => {
    test('rejects with error on non-ok response', () => {
      const mock = createFetchMock([
        {
          path: 'transit/encrypt/',
          respond: () => errorResponse(403, ['permission denied']),
        },
      ]);
      globalThis.fetch = mock.fn;

      return vaultKeyStore({
        vaultUrl: VAULT_URL,
        token: VAULT_TOKEN,
      })
        .initialize()
        .then((ks) =>
          ks.wrapDEK('personal', randomBytes(32)).then(
            () => {
              throw new Error('should have rejected');
            },
            (err) => {
              expect(err.message).toContain('permission denied');
              expect(err.status).toBe(403);
            },
          ),
        );
    });

    test('includes method and path in error message', () => {
      const mock = createFetchMock([
        {
          path: 'transit/decrypt/',
          respond: () => errorResponse(400, ['invalid ciphertext']),
        },
      ]);
      globalThis.fetch = mock.fn;

      return vaultKeyStore({
        vaultUrl: VAULT_URL,
        token: VAULT_TOKEN,
      })
        .initialize()
        .then((ks) =>
          ks.unwrapDEK('personal', 'bad-ct').then(
            () => {
              throw new Error('should have rejected');
            },
            (err) => {
              expect(err.message).toContain('POST');
              expect(err.message).toContain('transit/decrypt/personal');
              expect(err.message).toContain('invalid ciphertext');
            },
          ),
        );
    });

    test('uses statusText when no error messages', () => {
      const mock = createFetchMock([
        {
          path: 'transit/encrypt/',
          respond: () => ({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
            json: () => Promise.resolve({}),
          }),
        },
      ]);
      globalThis.fetch = mock.fn;

      return vaultKeyStore({
        vaultUrl: VAULT_URL,
        token: VAULT_TOKEN,
      })
        .initialize()
        .then((ks) =>
          ks.wrapDEK('personal', randomBytes(32)).then(
            () => {
              throw new Error('should have rejected');
            },
            (err) => {
              expect(err.message).toContain('Internal Server Error');
            },
          ),
        );
    });
  });

  describe('authenticateAppRole error handling', () => {
    test('rejects with useful error on malformed auth response', () => {
      const mock = createFetchMock([
        {
          path: 'auth/approle/login',
          respond: () =>
            okResponse({ data: { something_else: 'no token here' } }),
        },
      ]);
      globalThis.fetch = mock.fn;

      return vaultKeyStore({
        vaultUrl: VAULT_URL,
        authMethod: appRole({ roleId: 'role-1', secretId: 'secret-1' }),
      })
        .initialize()
        .then(
          () => {
            throw new Error('should have rejected');
          },
          (err) => {
            expect(err).toBeDefined();
          },
        );
    });
  });

  describe('vaultRequest error handling', () => {
    test('handles non-JSON error response body gracefully', () => {
      const mock = createFetchMock([]);
      // Override with a custom handler that returns non-JSON error
      globalThis.fetch = vi.fn((url) => {
        if (url.includes('approle')) {
          return Promise.resolve(
            okResponse({ auth: { client_token: 'test' } }),
          );
        }
        return Promise.resolve({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          json: () => Promise.reject(new Error('not valid JSON')),
        });
      });

      return vaultKeyStore({
        vaultUrl: VAULT_URL,
        authMethod: appRole({ roleId: 'r', secretId: 's' }),
      })
        .initialize()
        .then((ks) =>
          ks.wrapDEK('personal', randomBytes(32)).then(
            () => {
              throw new Error('should have rejected');
            },
            (err) => {
              // Should propagate some error, not crash obscurely
              expect(err).toBeDefined();
            },
          ),
        );
    });
  });

  describe('DEK storage with MongoDB backend', () => {
    test('initializes with MongoDB when dekBackend is provided', () => {
      const mockCollection = {
        findOne: vi.fn(() => Promise.resolve(null)),
        insertOne: vi.fn(() => Promise.resolve()),
        find: vi.fn(() => ({
          toArray: () => Promise.resolve([]),
        })),
        deleteMany: vi.fn(() => Promise.resolve({ deletedCount: 0 })),
      };
      const mockClient = {
        db: vi.fn(() => ({
          collection: vi.fn(() => mockCollection),
        })),
        close: vi.fn(() => Promise.resolve()),
      };

      vi.doMock('mongodb', () => ({
        MongoClient: {
          connect: vi.fn(() => Promise.resolve(mockClient)),
        },
      }));

      const mock = createFetchMock([
        {
          path: 'transit/encrypt/',
          respond: () => okResponse({ data: { ciphertext: 'vault:v1:ct' } }),
        },
      ]);
      globalThis.fetch = mock.fn;

      return import('../keystores/vault.js').then(({ vaultKeyStore: vs }) =>
        vs({
          vaultUrl: VAULT_URL,
          token: VAULT_TOKEN,
          dekBackend: {
            url: 'mongodb://localhost:27017',
            database: 'test-keys',
            collection: 'test-deks',
          },
        })
          .initialize()
          .then((ks) =>
            ks
              .storeDEK('sub-1', 'personal', {
                wrappedKey: 'vault:v1:ct',
                version: 1,
              })
              .then(() => {
                expect(mockCollection.insertOne).toHaveBeenCalledWith(
                  expect.objectContaining({
                    subjectId: 'sub-1',
                    context: 'personal',
                    wrappedKey: 'vault:v1:ct',
                    version: 1,
                  }),
                );
              }),
          ),
      );
    });
  });
});
