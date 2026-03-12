import { describe, test, expect, vi } from 'vitest';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

const { createFallbackHandler } = await import('../fallback.js');
const { defineEncryptionSchema } = await import('../schema.js');

const schema = defineEncryptionSchema({
  contexts: {
    personal: {
      fields: {
        location: { forgottenText: '[no location]' },
      },
    },
  },
  events: {
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
  },
});

describe('createFallbackHandler', () => {
  describe('applyFallbacks', () => {
    test('replaces encrypted fields with structured placeholder', () => {
      const handler = createFallbackHandler(schema);
      const event = {
        type: 'CUSTOMER_CREATED',
        aggregateId: 'cust-1',
        payload: {
          name: { __encrypted: true, ctx: 'personal' },
          location: { __encrypted: true, ctx: 'personal' },
        },
      };

      return handler.applyFallbacks(event).then((result) => {
        expect(result.payload.name).toEqual({
          forgotten: true,
          text: '[deleted]',
        });
        expect(result.payload.location).toEqual({
          forgotten: true,
          text: '[no location]',
        });
      });
    });

    test('uses custom default forgotten text from schema', () => {
      const customSchema = defineEncryptionSchema({
        defaults: { forgottenText: '[redacted]' },
        events: {
          CUSTOMER_CREATED: {
            'payload.name': {
              context: 'personal',
              subjectField: 'aggregateId',
            },
          },
        },
      });
      const handler = createFallbackHandler(customSchema);
      const event = {
        type: 'CUSTOMER_CREATED',
        aggregateId: 'cust-1',
        payload: {
          name: { __encrypted: true },
        },
      };

      return handler.applyFallbacks(event).then((result) => {
        expect(result.payload.name).toEqual({
          forgotten: true,
          text: '[redacted]',
        });
      });
    });

    test('passes through non-encrypted fields', () => {
      const handler = createFallbackHandler(schema);
      const event = {
        type: 'CUSTOMER_CREATED',
        aggregateId: 'cust-1',
        payload: { name: 'Alice', location: 'Berlin' },
      };

      return handler.applyFallbacks(event).then((result) => {
        expect(result.payload.name).toBe('Alice');
        expect(result.payload.location).toBe('Berlin');
      });
    });

    test('passes through events not in schema', () => {
      const handler = createFallbackHandler(schema);
      const event = {
        type: 'UNKNOWN',
        payload: { data: 'test' },
      };

      return handler.applyFallbacks(event).then((result) => {
        expect(result).toEqual(event);
      });
    });

    test('does not modify original event', () => {
      const handler = createFallbackHandler(schema);
      const event = {
        type: 'CUSTOMER_CREATED',
        aggregateId: 'cust-1',
        payload: { name: { __encrypted: true } },
      };

      return handler.applyFallbacks(event).then(() => {
        expect(event.payload.name.__encrypted).toBe(true);
      });
    });
  });
});
