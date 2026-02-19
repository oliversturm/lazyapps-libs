import { describe, test, expect, vi, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

const { createEncryption } = await import('../encryption.js');
const { defineEncryptionSchema } = await import('../schema.js');
const { inMemoryKeyStore } = await import('../keystores/inmemory.js');

const personalKEK = randomBytes(32);
const financialKEK = randomBytes(32);

const schema = defineEncryptionSchema({
  CUSTOMER_CREATED: {
    'payload.name': {
      context: 'personal',
      subjectField: 'aggregateId',
    },
  },
  CUSTOMER_UPDATED: {
    'payload.name': {
      context: 'personal',
      subjectField: 'aggregateId',
    },
  },
});

const multiContextSchema = defineEncryptionSchema({
  CUSTOMER_CREATED: {
    'payload.name': {
      context: 'personal',
      subjectField: 'aggregateId',
    },
    'payload.creditScore': {
      context: 'financial',
      subjectField: 'aggregateId',
    },
  },
});

const contexts = {
  personal: { roles: ['admin', 'support', 'self'] },
};

const multiContexts = {
  personal: { roles: ['admin', 'support', 'self'] },
  financial: { roles: ['admin'] },
};

const readModelEncryption = {
  customers: {
    name: { context: 'personal', subjectField: 'customerId' },
  },
};

const makeEncryption = () =>
  createEncryption({
    schema,
    keyStore: inMemoryKeyStore({ personal: personalKEK }),
    contexts,
    cache: { maxSize: 100, ttlMs: 60000 },
  });

const makeMultiContextEncryption = () =>
  createEncryption({
    schema: multiContextSchema,
    keyStore: inMemoryKeyStore({
      personal: personalKEK,
      financial: financialKEK,
    }),
    contexts: multiContexts,
    cache: { maxSize: 100, ttlMs: 60000 },
  });

const makeEncryptionWithStorage = () =>
  createEncryption({
    schema,
    keyStore: inMemoryKeyStore({ personal: personalKEK }),
    contexts,
    readModelEncryption,
    cache: { maxSize: 100, ttlMs: 60000 },
  });

describe('createEncryption', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('initializes and returns all expected methods', () =>
    makeEncryption().then((enc) => {
      expect(enc).toHaveProperty('wrapEventStore');
      expect(enc).toHaveProperty('wrapEventBus');
      expect(enc).toHaveProperty('createProjectionDecryptor');
      expect(enc).toHaveProperty('wrapStorage');
      expect(enc).toHaveProperty('createQueryDecryptor');
      expect(enc).toHaveProperty('forgetSubject');
      expect(enc).toHaveProperty('rotateContextKey');
      expect(enc).toHaveProperty('getSchema');
      expect(enc).toHaveProperty('getContexts');
    }));

  test('getSchema returns the schema', () =>
    makeEncryption().then((enc) => {
      expect(enc.getSchema()).toBe(schema);
    }));

  test('getContexts returns the contexts', () =>
    makeEncryption().then((enc) => {
      expect(enc.getContexts()).toBe(contexts);
    }));

  describe('wrapEventStore', () => {
    test('encrypts event on addEvent and returns plaintext', () =>
      makeEncryption().then((enc) => {
        const storedEvents = [];
        const mockStore = {
          addEvent: (correlationId) => (event) => {
            storedEvents.push(event);
            return Promise.resolve(event);
          },
          replay: vi.fn(),
          close: vi.fn(),
        };
        const wrappedFactory = enc.wrapEventStore(() =>
          Promise.resolve(mockStore),
        );

        return wrappedFactory().then((wrapped) =>
          wrapped
            .addEvent('corr-1')({
              type: 'CUSTOMER_CREATED',
              aggregateName: 'customer',
              aggregateId: 'cust-42',
              payload: { name: 'Alice Smith' },
              timestamp: 1234567890,
            })
            .then((returned) => {
              // Returned event should be plaintext (for aggregate
              // projection)
              expect(returned.payload.name).toBe('Alice Smith');

              // Stored event should be encrypted
              expect(storedEvents).toHaveLength(1);
              expect(storedEvents[0].payload.name.__encrypted).toBe(true);
              expect(storedEvents[0].payload.name.ctx).toBe('personal');
              expect(storedEvents[0].payload.name.kid).toBe('cust-42');
            }),
        );
      }));

    test('passes through events without schema definitions', () =>
      makeEncryption().then((enc) => {
        const storedEvents = [];
        const mockStore = {
          addEvent: () => (event) => {
            storedEvents.push(event);
            return Promise.resolve(event);
          },
          replay: vi.fn(),
          close: vi.fn(),
        };
        const wrappedFactory = enc.wrapEventStore(() =>
          Promise.resolve(mockStore),
        );

        return wrappedFactory().then((wrapped) =>
          wrapped
            .addEvent('corr-1')({
              type: 'ORDER_CREATED',
              aggregateName: 'order',
              aggregateId: 'ord-1',
              payload: { text: 'some order' },
              timestamp: 1234567890,
            })
            .then((returned) => {
              expect(returned.payload.text).toBe('some order');
              expect(storedEvents[0].payload.text).toBe('some order');
            }),
        );
      }));

    test('triggers crypto-shredding on SUBJECT_FORGOTTEN', () =>
      makeEncryption().then((enc) => {
        const mockStore = {
          addEvent: () => (event) => Promise.resolve(event),
          replay: vi.fn(),
          close: vi.fn(),
        };
        const wrappedFactory = enc.wrapEventStore(() =>
          Promise.resolve(mockStore),
        );

        return wrappedFactory().then((wrapped) =>
          // First encrypt something for this subject
          wrapped
            .addEvent('corr-1')({
              type: 'CUSTOMER_CREATED',
              aggregateName: 'customer',
              aggregateId: 'cust-99',
              payload: { name: 'Bob' },
              timestamp: 1,
            })
            .then(() =>
              // Now forget the subject
              wrapped.addEvent('corr-2')({
                type: 'SUBJECT_FORGOTTEN',
                aggregateName: 'subjectLifecycle',
                aggregateId: 'cust-99',
                payload: { subjectId: 'cust-99' },
                timestamp: 2,
              }),
            )
            .then((returned) => {
              expect(returned.type).toBe('SUBJECT_FORGOTTEN');
            }),
        );
      }));

    test('wraps replay to decrypt events for aggregate projection', () =>
      makeEncryption().then((enc) => {
        // Simulate events that would be stored encrypted in MongoDB
        const encryptedEvents = [];
        let capturedProjectionEvents = [];

        const mockStore = {
          addEvent: () => (event) => {
            encryptedEvents.push({ ...event });
            return Promise.resolve(event);
          },
          replay: (correlationId) => (cmdProcContext) =>
            // Simulate what the real replay does: iterate stored
            // events and call applyAggregateProjection
            encryptedEvents.reduce(
              (p, event) =>
                p.then(() =>
                  cmdProcContext.aggregateStore.applyAggregateProjection(
                    correlationId,
                  )(event),
                ),
              Promise.resolve(),
            ),
          close: vi.fn(),
        };

        const wrappedFactory = enc.wrapEventStore(() =>
          Promise.resolve(mockStore),
        );

        return wrappedFactory().then((wrapped) =>
          // Store an encrypted event
          wrapped
            .addEvent('corr-1')({
              type: 'CUSTOMER_CREATED',
              aggregateName: 'customer',
              aggregateId: 'cust-55',
              payload: { name: 'Charlie' },
              timestamp: 1,
            })
            .then(() => {
              // Verify the stored event is encrypted
              expect(encryptedEvents[0].payload.name.__encrypted).toBe(true);

              // Now replay with a mock cmdProcContext
              const mockCmdProcContext = {
                aggregateStore: {
                  startReplay: vi.fn(),
                  endReplay: vi.fn(),
                  applyAggregateProjection: () => (event) => {
                    capturedProjectionEvents.push(event);
                    return Promise.resolve(event);
                  },
                },
                eventBus: {
                  publishReplayState: () => vi.fn(),
                },
              };

              return wrapped
                .replay('corr-replay')(mockCmdProcContext)
                .then(() => {
                  // Aggregate projection should receive decrypted
                  // events
                  expect(capturedProjectionEvents).toHaveLength(1);
                  expect(capturedProjectionEvents[0].payload.name).toBe(
                    'Charlie',
                  );
                });
            }),
        );
      }));
  });

  describe('wrapEventBus', () => {
    test('encrypts plaintext events before publishing', () =>
      makeEncryption().then((enc) => {
        const published = [];
        const mockBus = {
          publishEvent: (correlationId) => (event) => {
            published.push(event);
            return event;
          },
          publishReplayState: vi.fn(),
        };
        const wrappedFactory = enc.wrapEventBus(() => Promise.resolve(mockBus));

        return wrappedFactory().then((wrapped) =>
          wrapped
            .publishEvent('corr-1')({
              type: 'CUSTOMER_CREATED',
              aggregateName: 'customer',
              aggregateId: 'cust-42',
              payload: { name: 'Alice' },
              timestamp: 1,
            })
            .then(() => {
              expect(published).toHaveLength(1);
              expect(published[0].payload.name.__encrypted).toBe(true);
            }),
        );
      }));

    test('passes through already-encrypted events', () =>
      makeEncryption().then((enc) => {
        const published = [];
        const mockBus = {
          publishEvent: () => (event) => {
            published.push(event);
            return event;
          },
          publishReplayState: vi.fn(),
        };
        const wrappedFactory = enc.wrapEventBus(() => Promise.resolve(mockBus));

        const alreadyEncrypted = {
          type: 'CUSTOMER_CREATED',
          aggregateName: 'customer',
          aggregateId: 'cust-42',
          payload: {
            name: {
              __encrypted: true,
              alg: 'aes-256-gcm',
              iv: 'abc',
              data: 'def',
              tag: 'ghi',
              ctx: 'personal',
              kid: 'cust-42',
              kv: 1,
            },
          },
          timestamp: 1,
        };

        return wrappedFactory().then((wrapped) =>
          Promise.resolve(
            wrapped.publishEvent('corr-1')(alreadyEncrypted),
          ).then(() => {
            expect(published).toHaveLength(1);
            // Should pass through without re-encryption
            expect(published[0].payload.name.__encrypted).toBe(true);
            expect(published[0].payload.name.iv).toBe('abc');
          }),
        );
      }));

    test('preserves non-encryption bus properties', () =>
      makeEncryption().then((enc) => {
        const mockBus = {
          publishEvent: () => () => ({}),
          publishReplayState: vi.fn(),
          someOtherMethod: vi.fn(),
        };
        const wrappedFactory = enc.wrapEventBus(() => Promise.resolve(mockBus));

        return wrappedFactory().then((wrapped) => {
          expect(wrapped.publishReplayState).toBe(mockBus.publishReplayState);
          expect(wrapped.someOtherMethod).toBe(mockBus.someOtherMethod);
        });
      }));
  });

  describe('createProjectionDecryptor', () => {
    test('decrypts event fields for authorized role', () =>
      makeEncryption().then((enc) => {
        const mockStore = {
          addEvent: () => (event) => Promise.resolve(event),
          replay: vi.fn(),
          close: vi.fn(),
        };
        const wrappedFactory = enc.wrapEventStore(() =>
          Promise.resolve(mockStore),
        );
        const decryptor = enc.createProjectionDecryptor('admin');

        // First encrypt an event to get proper encrypted output
        return wrappedFactory().then((wrapped) =>
          wrapped
            .addEvent('corr-1')({
              type: 'CUSTOMER_CREATED',
              aggregateName: 'customer',
              aggregateId: 'cust-42',
              payload: { name: 'Alice' },
              timestamp: 1,
            })
            .then(() => {
              // Encrypt directly for the bus (simulates what RM
              // receives)
              const busPublished = [];
              const mockBus = {
                publishEvent: () => (event) => {
                  busPublished.push(event);
                  return event;
                },
              };
              const wrappedBusFactory = enc.wrapEventBus(() =>
                Promise.resolve(mockBus),
              );

              return wrappedBusFactory().then((wrappedBus) =>
                wrappedBus
                  .publishEvent('corr-1')({
                    type: 'CUSTOMER_CREATED',
                    aggregateName: 'customer',
                    aggregateId: 'cust-42',
                    payload: { name: 'Alice' },
                    timestamp: 1,
                  })
                  .then(() =>
                    decryptor(busPublished[0]).then((decrypted) => {
                      expect(decrypted.payload.name).toBe('Alice');
                    }),
                  ),
              );
            }),
        );
      }));

    test('leaves fields encrypted for unauthorized role', () =>
      makeEncryption().then((enc) => {
        const contextsWithRestricted = {
          personal: { roles: ['admin'] },
        };

        // Create encryption with restricted contexts
        return createEncryption({
          schema,
          keyStore: inMemoryKeyStore({ personal: personalKEK }),
          contexts: contextsWithRestricted,
          cache: { maxSize: 100, ttlMs: 60000 },
        }).then((restrictedEnc) => {
          const decryptor =
            restrictedEnc.createProjectionDecryptor('public-api');

          const published = [];
          const mockBus = {
            publishEvent: () => (event) => {
              published.push(event);
              return event;
            },
          };
          const wrappedBusFactory = restrictedEnc.wrapEventBus(() =>
            Promise.resolve(mockBus),
          );

          return wrappedBusFactory().then((wrappedBus) =>
            wrappedBus
              .publishEvent('corr-1')({
                type: 'CUSTOMER_CREATED',
                aggregateName: 'customer',
                aggregateId: 'cust-42',
                payload: { name: 'Alice' },
                timestamp: 1,
              })
              .then(() =>
                decryptor(published[0]).then((decrypted) => {
                  // Name should still be encrypted (role not
                  // authorized)
                  expect(decrypted.payload.name.__encrypted).toBe(true);
                }),
              ),
          );
        });
      }));
  });

  describe('forgetSubject', () => {
    test('deletes DEKs and subsequent decryption uses fallback', () =>
      makeEncryption().then((enc) => {
        const published = [];
        const mockBus = {
          publishEvent: () => (event) => {
            published.push(event);
            return event;
          },
        };
        const wrappedBusFactory = enc.wrapEventBus(() =>
          Promise.resolve(mockBus),
        );

        return wrappedBusFactory().then((wrappedBus) =>
          // Encrypt an event
          wrappedBus
            .publishEvent('corr-1')({
              type: 'CUSTOMER_CREATED',
              aggregateName: 'customer',
              aggregateId: 'cust-77',
              payload: { name: 'Doomed' },
              timestamp: 1,
            })
            .then(() => enc.forgetSubject('cust-77'))
            .then(() => {
              // Try to decrypt — should get fallback
              const decryptor = enc.createProjectionDecryptor('admin');
              return decryptor(published[0]).then((result) => {
                expect(result.payload.name).toBe('[deleted]');
              });
            }),
        );
      }));
  });

  describe('wrapStorage', () => {
    test('returns storageFactory unchanged when no readModelEncryption', () =>
      makeEncryption().then((enc) => {
        const mockFactory = () => {};
        expect(enc.wrapStorage(mockFactory)).toBe(mockFactory);
      }));

    test('returns wrapped factory when readModelEncryption is set', () =>
      makeEncryptionWithStorage().then((enc) => {
        const mockMethods = {
          insertOne: vi.fn().mockResolvedValue({ acknowledged: true }),
          find: vi.fn().mockReturnValue({ toArray: () => [] }),
        };
        const mockStorageFactory = () =>
          Promise.resolve({
            perRequest: () => mockMethods,
            close: vi.fn(),
            updateLastProjectedEventTimestamps: vi.fn(),
          });

        const wrapped = enc.wrapStorage(mockStorageFactory);
        expect(wrapped).not.toBe(mockStorageFactory);

        return wrapped().then((storage) => {
          const methods = storage.perRequest('corr-1');
          return methods
            .insertOne('customers', {
              customerId: 'cust-1',
              name: 'Alice',
            })
            .then(() => {
              const doc = mockMethods.insertOne.mock.calls[0][1];
              expect(doc.name.__encrypted).toBe(true);
              expect(doc.name.ctx).toBe('personal');
            });
        });
      }));
  });

  describe('createQueryDecryptor', () => {
    test('returns null when no readModelEncryption', () =>
      makeEncryption().then((enc) => {
        expect(enc.createQueryDecryptor()).toBeNull();
      }));

    test('returns decryptor when readModelEncryption is set', () =>
      makeEncryptionWithStorage().then((enc) => {
        const qd = enc.createQueryDecryptor();
        expect(qd).not.toBeNull();
        expect(qd.decrypt).toBeTypeOf('function');
      }));
  });

  describe('multiple contexts in same event', () => {
    test('encrypts fields from different contexts', () =>
      makeMultiContextEncryption().then((enc) => {
        const storedEvents = [];
        const mockStore = {
          addEvent: () => (event) => {
            storedEvents.push(event);
            return Promise.resolve(event);
          },
          replay: vi.fn(),
          close: vi.fn(),
        };
        const wrappedFactory = enc.wrapEventStore(() =>
          Promise.resolve(mockStore),
        );

        return wrappedFactory().then((wrapped) =>
          wrapped
            .addEvent('corr-1')({
              type: 'CUSTOMER_CREATED',
              aggregateName: 'customer',
              aggregateId: 'cust-42',
              payload: { name: 'Alice', creditScore: 750 },
              timestamp: 1,
            })
            .then((returned) => {
              expect(returned.payload.name).toBe('Alice');
              expect(returned.payload.creditScore).toBe(750);
              expect(storedEvents[0].payload.name.__encrypted).toBe(true);
              expect(storedEvents[0].payload.name.ctx).toBe('personal');
              expect(storedEvents[0].payload.creditScore.__encrypted).toBe(
                true,
              );
              expect(storedEvents[0].payload.creditScore.ctx).toBe('financial');
            }),
        );
      }));

    test('projection decryptor with mixed context access', () =>
      makeMultiContextEncryption().then((enc) => {
        const published = [];
        const mockBus = {
          publishEvent: () => (event) => {
            published.push(event);
            return event;
          },
        };
        const wrappedFactory = enc.wrapEventBus(() => Promise.resolve(mockBus));

        // 'support' can access personal but not financial
        const decryptor = enc.createProjectionDecryptor('support');

        return wrappedFactory().then((wrapped) =>
          wrapped
            .publishEvent('corr-1')({
              type: 'CUSTOMER_CREATED',
              aggregateName: 'customer',
              aggregateId: 'cust-42',
              payload: { name: 'Alice', creditScore: 750 },
              timestamp: 1,
            })
            .then(() => decryptor(published[0]))
            .then((result) => {
              expect(result.payload.name).toBe('Alice');
              // support not in financial roles, stays encrypted
              expect(result.payload.creditScore.__encrypted).toBe(true);
            }),
        );
      }));
  });

  describe('multiple subjects with selective forget', () => {
    test('forgetting subject-A leaves subject-B decryptable', () =>
      makeEncryption().then((enc) => {
        const publishedA = [];
        const publishedB = [];
        const mockBus = {
          publishEvent: () => (event) => {
            if (event.aggregateId === 'cust-A') publishedA.push(event);
            else publishedB.push(event);
            return event;
          },
        };
        const wrappedFactory = enc.wrapEventBus(() => Promise.resolve(mockBus));

        return wrappedFactory().then((wrapped) =>
          wrapped
            .publishEvent('corr-1')({
              type: 'CUSTOMER_CREATED',
              aggregateName: 'customer',
              aggregateId: 'cust-A',
              payload: { name: 'Alice' },
              timestamp: 1,
            })
            .then(() =>
              wrapped.publishEvent('corr-2')({
                type: 'CUSTOMER_CREATED',
                aggregateName: 'customer',
                aggregateId: 'cust-B',
                payload: { name: 'Bob' },
                timestamp: 2,
              }),
            )
            .then(() => enc.forgetSubject('cust-A'))
            .then(() => {
              const decryptor = enc.createProjectionDecryptor('admin');
              return decryptor(publishedA[0]).then((resultA) => {
                expect(resultA.payload.name).toBe('[deleted]');
                return decryptor(publishedB[0]).then((resultB) => {
                  expect(resultB.payload.name).toBe('Bob');
                });
              });
            }),
        );
      }));
  });

  describe('full encryption pipeline', () => {
    test('projection decryptor → storage re-encrypt → query decrypt', () =>
      makeEncryptionWithStorage().then((enc) => {
        const published = [];
        const mockBus = {
          publishEvent: () => (event) => {
            published.push(event);
            return event;
          },
        };
        const wrappedBusFactory = enc.wrapEventBus(() =>
          Promise.resolve(mockBus),
        );

        const storedDocs = [];
        const mockMethods = {
          insertOne: vi.fn((collection, doc) => {
            storedDocs.push(doc);
            return Promise.resolve({ acknowledged: true });
          }),
          find: vi.fn().mockReturnValue({ toArray: () => [] }),
        };
        const mockStorageFactory = () =>
          Promise.resolve({
            perRequest: () => mockMethods,
            close: vi.fn(),
            updateLastProjectedEventTimestamps: vi.fn(),
          });
        const wrappedStorageFactory = enc.wrapStorage(mockStorageFactory);
        const queryDecryptor = enc.createQueryDecryptor();
        const projDecryptor = enc.createProjectionDecryptor('admin');

        return wrappedBusFactory().then((wrappedBus) =>
          wrappedBus
            .publishEvent('corr-1')({
              type: 'CUSTOMER_CREATED',
              aggregateName: 'customer',
              aggregateId: 'cust-42',
              payload: { name: 'Alice' },
              timestamp: 1,
            })
            .then(() => projDecryptor(published[0]))
            .then((decryptedEvent) =>
              wrappedStorageFactory().then((storage) => {
                const methods = storage.perRequest('corr-1');
                return methods
                  .insertOne('customers', {
                    customerId: decryptedEvent.aggregateId,
                    name: decryptedEvent.payload.name,
                  })
                  .then(() => {
                    // Storage should have re-encrypted the doc
                    expect(storedDocs[0].name.__encrypted).toBe(true);

                    return queryDecryptor
                      .decrypt(storedDocs[0], {
                        roles: ['admin'],
                        identity: 'user-99',
                        subjectField: 'customerId',
                      })
                      .then((result) => {
                        expect(result.name).toBe('Alice');
                        expect(result.customerId).toBe('cust-42');
                      });
                  });
              }),
            ),
        );
      }));
  });

  describe('backward compatibility', () => {
    test('non-encrypted events pass through all wrappers unchanged', () =>
      makeEncryption().then((enc) => {
        const storedEvents = [];
        const publishedEvents = [];
        const mockStore = {
          addEvent: () => (event) => {
            storedEvents.push(event);
            return Promise.resolve(event);
          },
          replay: vi.fn(),
          close: vi.fn(),
        };
        const mockBus = {
          publishEvent: () => (event) => {
            publishedEvents.push(event);
            return event;
          },
          publishReplayState: vi.fn(),
        };
        const wrappedStoreFactory = enc.wrapEventStore(() =>
          Promise.resolve(mockStore),
        );
        const wrappedBusFactory = enc.wrapEventBus(() =>
          Promise.resolve(mockBus),
        );

        const nonEncryptedEvent = {
          type: 'ORDER_CREATED',
          aggregateName: 'order',
          aggregateId: 'ord-1',
          payload: { item: 'Widget', qty: 5 },
          timestamp: 1,
        };

        return Promise.all([wrappedStoreFactory(), wrappedBusFactory()]).then(
          ([wrappedStore, wrappedBus]) =>
            wrappedStore
              .addEvent('corr-1')(nonEncryptedEvent)
              .then(() => wrappedBus.publishEvent('corr-2')(nonEncryptedEvent))
              .then(() => {
                // Event store: no encryption applied
                expect(storedEvents[0].payload.item).toBe('Widget');
                expect(storedEvents[0].payload.qty).toBe(5);
                // Event bus: no encryption applied
                expect(publishedEvents[0].payload.item).toBe('Widget');
                expect(publishedEvents[0].payload.qty).toBe(5);
              }),
        );
      }));

    test('mixed encrypted and non-encrypted events in sequence', () =>
      makeEncryption().then((enc) => {
        const storedEvents = [];
        const mockStore = {
          addEvent: () => (event) => {
            storedEvents.push(event);
            return Promise.resolve(event);
          },
          replay: vi.fn(),
          close: vi.fn(),
        };
        const wrappedFactory = enc.wrapEventStore(() =>
          Promise.resolve(mockStore),
        );

        return wrappedFactory().then((wrapped) =>
          wrapped
            .addEvent('corr-1')({
              type: 'CUSTOMER_CREATED',
              aggregateName: 'customer',
              aggregateId: 'cust-1',
              payload: { name: 'Alice' },
              timestamp: 1,
            })
            .then(() =>
              wrapped.addEvent('corr-2')({
                type: 'ORDER_CREATED',
                aggregateName: 'order',
                aggregateId: 'ord-1',
                payload: { item: 'Widget' },
                timestamp: 2,
              }),
            )
            .then(() =>
              wrapped.addEvent('corr-3')({
                type: 'CUSTOMER_UPDATED',
                aggregateName: 'customer',
                aggregateId: 'cust-1',
                payload: { name: 'Alice Smith' },
                timestamp: 3,
              }),
            )
            .then(() => {
              expect(storedEvents).toHaveLength(3);
              // First: encrypted
              expect(storedEvents[0].payload.name.__encrypted).toBe(true);
              // Second: not in schema, plaintext
              expect(storedEvents[1].payload.item).toBe('Widget');
              // Third: encrypted
              expect(storedEvents[2].payload.name.__encrypted).toBe(true);
            }),
        );
      }));
  });
});
