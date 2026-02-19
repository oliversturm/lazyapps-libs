import { describe, test, expect, vi, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';

const { createFieldEncryptor } = await import('../fieldEncryption.js');

const testDEK = randomBytes(32);

const mockEnvelope = {
  getDEK: vi.fn().mockResolvedValue({ key: testDEK, version: 1 }),
};

const schema = {
  CUSTOMER_CREATED: {
    'payload.name': {
      context: 'personal',
      subjectField: 'aggregateId',
    },
    'payload.location': {
      context: 'personal',
      subjectField: 'aggregateId',
    },
  },
};

const multiFieldSchema = {
  CUSTOMER_FULL: {
    'payload.name': {
      context: 'personal',
      subjectField: 'aggregateId',
    },
    'payload.email': {
      context: 'personal',
      subjectField: 'aggregateId',
    },
    'payload.phone': {
      context: 'personal',
      subjectField: 'aggregateId',
    },
    'payload.address': {
      context: 'personal',
      subjectField: 'aggregateId',
    },
  },
};

const nestedSchema = {
  ADDRESS_UPDATED: {
    'payload.address.street': {
      context: 'personal',
      subjectField: 'aggregateId',
    },
    'payload.address.city': {
      context: 'personal',
      subjectField: 'aggregateId',
    },
  },
};

const contexts = {
  personal: { roles: ['admin', 'support'] },
};

describe('createFieldEncryptor', () => {
  let encryptor;

  beforeEach(() => {
    vi.clearAllMocks();
    encryptor = createFieldEncryptor(mockEnvelope, schema);
  });

  describe('encryptEvent', () => {
    test('encrypts fields defined in schema', () => {
      const event = {
        type: 'CUSTOMER_CREATED',
        aggregateId: 'cust-1',
        payload: { name: 'Alice', location: 'Berlin' },
      };

      return encryptor.encryptEvent(event).then((result) => {
        expect(result.payload.name.__encrypted).toBe(true);
        expect(result.payload.name.alg).toBe('aes-256-gcm');
        expect(result.payload.name.ctx).toBe('personal');
        expect(result.payload.name.kid).toBe('cust-1');
        expect(result.payload.name.kv).toBe(1);
        expect(result.payload.location.__encrypted).toBe(true);
      });
    });

    test('does not modify original event', () => {
      const event = {
        type: 'CUSTOMER_CREATED',
        aggregateId: 'cust-1',
        payload: { name: 'Alice', location: 'Berlin' },
      };

      return encryptor.encryptEvent(event).then(() => {
        expect(event.payload.name).toBe('Alice');
      });
    });

    test('passes through events not in schema', () => {
      const event = {
        type: 'UNKNOWN_EVENT',
        aggregateId: 'x',
        payload: { data: 'test' },
      };

      return encryptor.encryptEvent(event).then((result) => {
        expect(result).toEqual(event);
      });
    });

    test('skips null/undefined field values', () => {
      const event = {
        type: 'CUSTOMER_CREATED',
        aggregateId: 'cust-1',
        payload: { name: null },
      };

      return encryptor.encryptEvent(event).then((result) => {
        expect(result.payload.name).toBeNull();
      });
    });

    test('skips if subjectField is missing', () => {
      const event = {
        type: 'CUSTOMER_CREATED',
        payload: { name: 'Alice' },
      };

      return encryptor.encryptEvent(event).then((result) => {
        expect(result.payload.name).toBe('Alice');
      });
    });

    test('encrypts 3+ fields in a single event', () => {
      const multiEncryptor = createFieldEncryptor(
        mockEnvelope,
        multiFieldSchema,
      );
      const event = {
        type: 'CUSTOMER_FULL',
        aggregateId: 'cust-1',
        payload: {
          name: 'Alice',
          email: 'alice@example.com',
          phone: '+49123456',
          address: '123 Main St',
        },
      };

      return multiEncryptor.encryptEvent(event).then((result) => {
        expect(result.payload.name.__encrypted).toBe(true);
        expect(result.payload.email.__encrypted).toBe(true);
        expect(result.payload.phone.__encrypted).toBe(true);
        expect(result.payload.address.__encrypted).toBe(true);
      });
    });

    test('preserves mixed encrypted/non-encrypted fields', () => {
      const event = {
        type: 'CUSTOMER_CREATED',
        aggregateId: 'cust-1',
        payload: {
          name: 'Alice',
          location: 'Berlin',
          accountType: 'premium',
          visits: 42,
        },
      };

      return encryptor.encryptEvent(event).then((result) => {
        expect(result.payload.name.__encrypted).toBe(true);
        expect(result.payload.location.__encrypted).toBe(true);
        expect(result.payload.accountType).toBe('premium');
        expect(result.payload.visits).toBe(42);
      });
    });

    test('encrypts nested path fields', () => {
      const nestedEncryptor = createFieldEncryptor(mockEnvelope, nestedSchema);
      const event = {
        type: 'ADDRESS_UPDATED',
        aggregateId: 'cust-1',
        payload: {
          address: { street: '123 Main St', city: 'Berlin' },
        },
      };

      return nestedEncryptor.encryptEvent(event).then((result) => {
        expect(result.payload.address.street.__encrypted).toBe(true);
        expect(result.payload.address.city.__encrypted).toBe(true);
      });
    });

    test('round-trips nested path encrypt/decrypt', () => {
      const nestedEncryptor = createFieldEncryptor(mockEnvelope, nestedSchema);
      const event = {
        type: 'ADDRESS_UPDATED',
        aggregateId: 'cust-1',
        payload: {
          address: { street: '123 Main St', city: 'Berlin' },
        },
      };

      return nestedEncryptor
        .encryptEvent(event)
        .then((encrypted) => nestedEncryptor.decryptEvent(encrypted))
        .then((decrypted) => {
          expect(decrypted.payload.address.street).toBe('123 Main St');
          expect(decrypted.payload.address.city).toBe('Berlin');
        });
    });

    test('skips undefined field values', () => {
      const event = {
        type: 'CUSTOMER_CREATED',
        aggregateId: 'cust-1',
        payload: { name: undefined },
      };

      return encryptor.encryptEvent(event).then((result) => {
        expect(result.payload.name).toBeUndefined();
      });
    });
  });

  describe('decryptEvent', () => {
    test('round-trips encrypt then decrypt', () => {
      const event = {
        type: 'CUSTOMER_CREATED',
        aggregateId: 'cust-1',
        payload: { name: 'Alice', location: 'Berlin' },
      };

      return encryptor
        .encryptEvent(event)
        .then((encrypted) => encryptor.decryptEvent(encrypted))
        .then((decrypted) => {
          expect(decrypted.payload.name).toBe('Alice');
          expect(decrypted.payload.location).toBe('Berlin');
        });
    });

    test('respects role-based access control', () => {
      const event = {
        type: 'CUSTOMER_CREATED',
        aggregateId: 'cust-1',
        payload: { name: 'Alice', location: 'Berlin' },
      };

      return encryptor
        .encryptEvent(event)
        .then((encrypted) =>
          encryptor.decryptEvent(encrypted, {
            role: 'public-api',
            contexts,
          }),
        )
        .then((result) => {
          // public-api not in personal.roles — fields stay encrypted
          expect(result.payload.name.__encrypted).toBe(true);
        });
    });

    test('decrypts for authorized role', () => {
      const event = {
        type: 'CUSTOMER_CREATED',
        aggregateId: 'cust-1',
        payload: { name: 'Alice', location: 'Berlin' },
      };

      return encryptor
        .encryptEvent(event)
        .then((encrypted) =>
          encryptor.decryptEvent(encrypted, {
            role: 'admin',
            contexts,
          }),
        )
        .then((result) => {
          expect(result.payload.name).toBe('Alice');
          expect(result.payload.location).toBe('Berlin');
        });
    });

    test('passes through events not in schema', () => {
      const event = {
        type: 'UNKNOWN_EVENT',
        payload: { data: 'test' },
      };

      return encryptor.decryptEvent(event).then((result) => {
        expect(result).toEqual(event);
      });
    });

    test('passes through non-encrypted field values', () => {
      const event = {
        type: 'CUSTOMER_CREATED',
        aggregateId: 'cust-1',
        payload: { name: 'plaintext', location: 'plaintext' },
      };

      return encryptor.decryptEvent(event).then((result) => {
        expect(result.payload.name).toBe('plaintext');
      });
    });
  });

  describe('hasEncryptedFields', () => {
    test('returns false for plaintext event', () => {
      const event = {
        type: 'CUSTOMER_CREATED',
        aggregateId: 'cust-1',
        payload: { name: 'Alice' },
      };
      expect(encryptor.hasEncryptedFields(event)).toBe(false);
    });

    test('returns true for encrypted event', () =>
      encryptor
        .encryptEvent({
          type: 'CUSTOMER_CREATED',
          aggregateId: 'cust-1',
          payload: { name: 'Alice', location: 'Berlin' },
        })
        .then((encrypted) => {
          expect(encryptor.hasEncryptedFields(encrypted)).toBe(true);
        }));

    test('returns false for event not in schema', () => {
      expect(
        encryptor.hasEncryptedFields({
          type: 'UNKNOWN',
          payload: {},
        }),
      ).toBe(false);
    });
  });
});
