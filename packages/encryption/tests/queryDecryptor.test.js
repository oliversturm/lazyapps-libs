import { describe, test, expect, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';

const { createQueryDecryptor } = await import('../queryDecryptor.js');
const { encryptValue } = await import('../fieldEncryption.js');
const { inMemoryKeyStore } = await import('../keystores/inmemory.js');
const { createEnvelopeManager } = await import('../envelopeEncryption.js');

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

const fallbackValue = '[deleted]';

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
          fallbackValue,
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

  test('unauthorized role gets [restricted]', () =>
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
          expect(result.name).toBe('[restricted]');
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
          expect(result.email).toBe('[restricted]');
        }),
    ));

  test('shredded subject gets fallback value', () =>
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
            fallbackValue,
            contexts,
          );
          return shreddedDecryptor.decrypt(doc, {
            roles: ['admin'],
            identity: 'user-99',
            subjectField: 'customerId',
          });
        })
        .then((result) => {
          expect(result.name).toBe('[deleted]');
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
          expect(result.balance).toBe('[restricted]');
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
});
