import { describe, test, expect, beforeEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

const { createQueryDecryptor } = await import('../queryDecryptor.js');
const { encryptValue } = await import('../fieldEncryption.js');
const { inMemoryKeyStore } = await import('../keystores/inmemory.js');
const { createEnvelopeManager } = await import('../envelopeEncryption.js');
const { defineEncryptionSchema } = await import('../schema.js');

const personalKEK = randomBytes(32);
const contactKEK = randomBytes(32);

const contexts = {
  personal: { roles: ['admin', 'support', 'self'] },
  contact: { roles: ['admin', 'support'] },
  financial: { roles: ['admin'] },
};

const readModelEncryption = {
  customers: {
    name: { context: 'personal', subjectField: 'customerId' },
    email: { context: 'contact', subjectField: 'customerId' },
  },
};

const schema = defineEncryptionSchema({ events: {} });

describe('createQueryDecryptor', () => {
  let envelope;
  let decryptor;
  let testDEK;

  const makeEncryptedDoc = (fields) => {
    const doc = { ...fields };
    const encryptedEntries = Object.entries(fields).filter(
      ([, v]) => v && v.__shouldEncrypt,
    );
    return encryptedEntries
      .reduce(
        (promise, [fieldName, config]) =>
          promise.then((d) =>
            envelope.getDEK(config.kid, config.ctx).then((dek) => ({
              ...d,
              [fieldName]: {
                ...encryptValue(dek.key, config.plaintext),
                ctx: config.ctx,
                kid: config.kid,
                kv: dek.version,
              },
            })),
          ),
        Promise.resolve(doc),
      )
      .then((d) => {
        for (const [fieldName, config] of Object.entries(fields)) {
          if (config && config.__shouldEncrypt) continue;
        }
        return d;
      });
  };

  beforeEach(() =>
    inMemoryKeyStore({ personal: personalKEK, contact: contactKEK })
      .initialize()
      .then((ks) => {
        envelope = createEnvelopeManager(ks, contexts);
        decryptor = createQueryDecryptor(
          readModelEncryption,
          envelope,
          schema,
          contexts,
        );
      }),
  );

  test('authorized role can decrypt fields', () =>
    makeEncryptedDoc({
      customerId: 'cust-1',
      name: {
        __shouldEncrypt: true,
        plaintext: 'Alice',
        ctx: 'personal',
        kid: 'cust-1',
      },
      accountType: 'premium',
    }).then((doc) =>
      decryptor
        .decrypt(doc, {
          roles: ['admin'],
          identity: 'user-99',
          subjectField: 'customerId',
        })
        .then((result) => {
          expect(result.name).toBe('Alice');
          expect(result.accountType).toBe('premium');
          expect(result.customerId).toBe('cust-1');
        }),
    ));

  test('unauthorized role gets structured restricted placeholder', () =>
    makeEncryptedDoc({
      customerId: 'cust-1',
      name: {
        __shouldEncrypt: true,
        plaintext: 'Alice',
        ctx: 'personal',
        kid: 'cust-1',
      },
    }).then((doc) =>
      decryptor
        .decrypt(doc, {
          roles: ['public-api'],
          identity: 'user-99',
          subjectField: 'customerId',
        })
        .then((result) => {
          expect(result.name).toEqual({
            unauthorized: true,
            text: '[restricted]',
          });
        }),
    ));

  test('self-access works when identity matches subjectField', () =>
    makeEncryptedDoc({
      customerId: 'cust-1',
      name: {
        __shouldEncrypt: true,
        plaintext: 'Alice',
        ctx: 'personal',
        kid: 'cust-1',
      },
    }).then((doc) =>
      decryptor
        .decrypt(doc, {
          roles: ['customer'],
          identity: 'cust-1',
          subjectField: 'customerId',
        })
        .then((result) => {
          expect(result.name).toBe('Alice');
        }),
    ));

  test('self-access does not grant access to contexts without self role', () =>
    makeEncryptedDoc({
      customerId: 'cust-1',
      email: {
        __shouldEncrypt: true,
        plaintext: 'alice@example.com',
        ctx: 'contact',
        kid: 'cust-1',
      },
    }).then((doc) =>
      decryptor
        .decrypt(doc, {
          roles: ['customer'],
          identity: 'cust-1',
          subjectField: 'customerId',
        })
        .then((result) => {
          // contact context only has ['admin', 'support'], not 'self'
          expect(result.email).toEqual({
            unauthorized: true,
            text: '[restricted]',
          });
        }),
    ));

  test('shredded subject gets structured forgotten placeholder', () =>
    makeEncryptedDoc({
      customerId: 'cust-shred',
      name: {
        __shouldEncrypt: true,
        plaintext: 'Gone',
        ctx: 'personal',
        kid: 'cust-shred',
      },
    }).then((doc) =>
      // Delete the DEK to simulate crypto-shredding
      inMemoryKeyStore({ personal: personalKEK })
        .initialize()
        .then((freshKs) => {
          // The original envelope has the DEK cached, but if
          // we create a fresh envelope without the DEK, getDEK
          // will create a new one which won't decrypt old data.
          // Instead, we delete from the key store and use a
          // decryptor that will fail on decrypt.
          const badDEK = randomBytes(32);
          const badEnvelope = {
            getDEK: () => Promise.resolve({ key: badDEK, version: 1 }),
          };
          const shreddedDecryptor = createQueryDecryptor(
            readModelEncryption,
            badEnvelope,
            schema,
            contexts,
          );
          return shreddedDecryptor.decrypt(doc, {
            roles: ['admin'],
            identity: 'user-99',
            subjectField: 'customerId',
          });
        })
        .then((result) => {
          expect(result.name).toEqual({
            forgotten: true,
            text: '[deleted]',
          });
        }),
    ));

  test('non-encrypted fields pass through unchanged', () => {
    const doc = {
      customerId: 'cust-1',
      accountType: 'premium',
      createdAt: '2024-01-01',
    };
    return decryptor
      .decrypt(doc, {
        roles: ['admin'],
        identity: 'user-99',
        subjectField: 'customerId',
      })
      .then((result) => {
        expect(result.customerId).toBe('cust-1');
        expect(result.accountType).toBe('premium');
        expect(result.createdAt).toBe('2024-01-01');
      });
  });

  test('multiple encrypted fields with different contexts', () =>
    makeEncryptedDoc({
      customerId: 'cust-1',
      name: {
        __shouldEncrypt: true,
        plaintext: 'Alice',
        ctx: 'personal',
        kid: 'cust-1',
      },
      email: {
        __shouldEncrypt: true,
        plaintext: 'alice@example.com',
        ctx: 'contact',
        kid: 'cust-1',
      },
    }).then((doc) =>
      decryptor
        .decrypt(doc, {
          roles: ['support'],
          identity: 'user-99',
          subjectField: 'customerId',
        })
        .then((result) => {
          // support role has access to both personal and contact
          expect(result.name).toBe('Alice');
          expect(result.email).toBe('alice@example.com');
        }),
    ));

  test('mixed access — some fields authorized, some restricted', () =>
    makeEncryptedDoc({
      customerId: 'cust-1',
      name: {
        __shouldEncrypt: true,
        plaintext: 'Alice',
        ctx: 'personal',
        kid: 'cust-1',
      },
      email: {
        __shouldEncrypt: true,
        plaintext: 'alice@example.com',
        ctx: 'contact',
        kid: 'cust-1',
      },
    }).then((doc) => {
      // Temporarily add a 'financial' encrypted field manually
      doc.balance = {
        __encrypted: true,
        alg: 'aes-256-gcm',
        iv: 'dummyiv',
        data: 'dummydata',
        tag: 'dummytag',
        ctx: 'financial',
        kid: 'cust-1',
        kv: 1,
      };
      return decryptor
        .decrypt(doc, {
          roles: ['support'],
          identity: 'user-99',
          subjectField: 'customerId',
        })
        .then((result) => {
          expect(result.name).toBe('Alice');
          expect(result.email).toBe('alice@example.com');
          // support not in financial.roles — restricted
          expect(result.balance).toEqual({
            unauthorized: true,
            text: '[restricted]',
          });
        });
    }));

  test('mixed encrypted/non-encrypted document', () =>
    makeEncryptedDoc({
      customerId: 'cust-1',
      name: {
        __shouldEncrypt: true,
        plaintext: 'Alice',
        ctx: 'personal',
        kid: 'cust-1',
      },
      accountType: 'premium',
      createdAt: '2024-01-01',
      visits: 42,
    }).then((doc) =>
      decryptor
        .decrypt(doc, {
          roles: ['admin'],
          identity: 'user-99',
          subjectField: 'customerId',
        })
        .then((result) => {
          expect(result.name).toBe('Alice');
          expect(result.customerId).toBe('cust-1');
          expect(result.accountType).toBe('premium');
          expect(result.createdAt).toBe('2024-01-01');
          expect(result.visits).toBe(42);
        }),
    ));

  test('self-access combined with other roles', () =>
    makeEncryptedDoc({
      customerId: 'cust-1',
      name: {
        __shouldEncrypt: true,
        plaintext: 'Alice',
        ctx: 'personal',
        kid: 'cust-1',
      },
      email: {
        __shouldEncrypt: true,
        plaintext: 'alice@example.com',
        ctx: 'contact',
        kid: 'cust-1',
      },
    }).then((doc) =>
      decryptor
        .decrypt(doc, {
          roles: ['customer', 'support'],
          identity: 'cust-1',
          subjectField: 'customerId',
        })
        .then((result) => {
          // personal has 'self' in roles, identity matches: decrypts
          expect(result.name).toBe('Alice');
          // support is in contact.roles: decrypts
          expect(result.email).toBe('alice@example.com');
        }),
    ));

  test('returns null/undefined documents as-is', () =>
    decryptor
      .decrypt(null, {
        roles: ['admin'],
        identity: 'user-99',
        subjectField: 'customerId',
      })
      .then((result) => {
        expect(result).toBeNull();
      }));

  test('returns restricted when __encrypted references unknown context', () => {
    const doc = {
      customerId: 'cust-1',
      name: {
        __encrypted: true,
        alg: 'aes-256-gcm',
        iv: 'dummyiv',
        data: 'dummydata',
        tag: 'dummytag',
        ctx: 'nonexistent-context',
        kid: 'cust-1',
        kv: 1,
      },
    };
    return decryptor
      .decrypt(doc, {
        roles: ['admin'],
        identity: 'user-99',
        subjectField: 'customerId',
      })
      .then((result) => {
        // Unknown context means no contextConfig match, so not authorized
        expect(result.name).toEqual({
          unauthorized: true,
          text: '[restricted]',
        });
      });
  });

  test('isSelf is false when identity is undefined', () =>
    makeEncryptedDoc({
      customerId: 'cust-1',
      name: {
        __shouldEncrypt: true,
        plaintext: 'Alice',
        ctx: 'personal',
        kid: 'cust-1',
      },
    }).then((doc) =>
      decryptor
        .decrypt(doc, {
          roles: ['customer'],
          identity: undefined,
          subjectField: 'customerId',
        })
        .then((result) => {
          // Without identity, self role is not granted
          // customer is not in personal.roles, so restricted
          expect(result.name).toEqual({
            unauthorized: true,
            text: '[restricted]',
          });
        }),
    ));

  test('not self-access when subjectField does not match identity', () =>
    makeEncryptedDoc({
      customerId: 'cust-1',
      name: {
        __shouldEncrypt: true,
        plaintext: 'Alice',
        ctx: 'personal',
        kid: 'cust-1',
      },
    }).then((doc) =>
      decryptor
        .decrypt(doc, {
          roles: ['customer'],
          identity: 'different-user',
          subjectField: 'customerId',
        })
        .then((result) => {
          // customer is not in personal roles, and identity != customerId
          expect(result.name).toEqual({
            unauthorized: true,
            text: '[restricted]',
          });
        }),
    ));

  test('per-field self-access via kid when subjectField is omitted', () =>
    makeEncryptedDoc({
      customerId: 'cust-1',
      name: {
        __shouldEncrypt: true,
        plaintext: 'Alice',
        ctx: 'personal',
        kid: 'cust-1',
      },
    }).then((doc) =>
      decryptor
        .decrypt(doc, {
          roles: ['customer'],
          identity: 'cust-1',
        })
        .then((result) => {
          // No subjectField, but identity matches kid → self access
          expect(result.name).toBe('Alice');
        }),
    ));

  test('per-field self-access denied when identity does not match kid', () =>
    makeEncryptedDoc({
      customerId: 'cust-1',
      name: {
        __shouldEncrypt: true,
        plaintext: 'Alice',
        ctx: 'personal',
        kid: 'cust-1',
      },
    }).then((doc) =>
      decryptor
        .decrypt(doc, {
          roles: ['customer'],
          identity: 'other-user',
        })
        .then((result) => {
          expect(result.name).toEqual({
            unauthorized: true,
            text: '[restricted]',
          });
        }),
    ));

  test('per-field self-access checks each field independently', () =>
    Promise.all([
      makeEncryptedDoc({
        customerId: 'cust-1',
        name: {
          __shouldEncrypt: true,
          plaintext: 'Alice',
          ctx: 'personal',
          kid: 'cust-1',
        },
      }),
    ]).then(([doc]) => {
      // Add a second encrypted field with a different kid
      return envelope.getDEK('cust-2', 'personal').then((dek) => {
        doc.otherName = {
          ...encryptValue(dek.key, 'Bob'),
          ctx: 'personal',
          kid: 'cust-2',
          kv: dek.version,
        };
        return decryptor
          .decrypt(doc, {
            roles: ['customer'],
            identity: 'cust-1',
          })
          .then((result) => {
            // name has kid=cust-1 matching identity → self access
            expect(result.name).toBe('Alice');
            // otherName has kid=cust-2, not matching identity → restricted
            expect(result.otherName).toEqual({
              unauthorized: true,
              text: '[restricted]',
            });
          });
      });
    }));
});
