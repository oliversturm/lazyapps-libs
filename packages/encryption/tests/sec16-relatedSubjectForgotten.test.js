import { describe, test, expect, vi } from 'vitest';
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

const schema = defineEncryptionSchema({
  events: {
    CUSTOMER_CREATED: {
      'payload.name': {
        context: 'personal',
        subjectField: 'aggregateId',
      },
      'payload.email': {
        context: 'personal',
        subjectField: 'aggregateId',
      },
    },
  },
});

const contexts = {
  personal: { roles: ['admin', 'support'], autoForget: true },
};

describe('SEC-16: RELATED_SUBJECT_FORGOTTEN bypass', () => {
  test('shredIfForget deletes DEKs when RELATED_SUBJECT_FORGOTTEN is stored via wrapped event store', () => {
    return createEncryption({
      schema,
      keyStore: inMemoryKeyStore({ personal: personalKEK }),
      contexts,
      cache: { maxSize: 100, ttlMs: 60000 },
    }).then((enc) => {
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
        // Step 1: Store an event with PII to create DEKs for the subject
        wrapped
          .addEvent('corr-1')({
            type: 'CUSTOMER_CREATED',
            aggregateName: 'customer',
            aggregateId: 'cust-related-1',
            payload: { name: 'Alice', email: 'alice@example.com' },
            timestamp: 1,
          })
          .then(() => {
            // Verify encryption works before forget
            const decryptor = enc.createProjectionDecryptor('admin');
            return decryptor(storedEvents[0]).then((decrypted) => {
              expect(decrypted.payload.name).toBe('Alice');
              return decryptor;
            });
          })
          .then((decryptor) =>
            // Step 2: Store a RELATED_SUBJECT_FORGOTTEN event through the
            // wrapped store — this should trigger crypto-shredding just like
            // SUBJECT_FORGOTTEN does, but the bug means it doesn't.
            wrapped
              .addEvent('corr-2')({
                type: 'RELATED_SUBJECT_FORGOTTEN',
                aggregateName: 'customer',
                aggregateId: 'parent-aggregate',
                payload: {
                  relatedSubjectId: 'cust-related-1',
                  relatedSubjectType: 'customer',
                  subjectId: 'cust-related-1',
                  contexts: ['personal'],
                },
                timestamp: 2,
              })
              .then(() =>
                // Step 3: Attempt to decrypt — should return fallback because
                // DEKs should have been deleted by shredIfForget.
                decryptor(storedEvents[0]).then((afterForget) => {
                  expect(afterForget.payload.name).toEqual({
                    forgotten: true,
                    text: '[deleted]',
                  });
                  expect(afterForget.payload.email).toEqual({
                    forgotten: true,
                    text: '[deleted]',
                  });
                }),
              ),
          ),
      );
    });
  });

  test('forgetMixin does not include RELATED_SUBJECT_FORGOTTEN (application-level concern)', () => {
    return createEncryption({
      schema,
      keyStore: inMemoryKeyStore({ personal: personalKEK }),
      contexts,
      cache: { maxSize: 100, ttlMs: 60000 },
    }).then((enc) => {
      const mixin = enc.createForgetMixin();
      // RELATED_SUBJECT_FORGOTTEN is handled by application-level aggregates
      // (e.g. order.js), not by the framework mixin. The mixin only provides
      // SUBJECT_FORGOTTEN projection for the subject's own aggregate.
      expect(mixin.projections).not.toHaveProperty('RELATED_SUBJECT_FORGOTTEN');
      expect(mixin.commands).not.toHaveProperty('FORGET_RELATED_SUBJECT');
    });
  });
});
