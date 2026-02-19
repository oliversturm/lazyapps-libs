import { describe, test, expect } from 'vitest';

const { createFallbackHandler } = await import('../fallback.js');

const schema = {
  CUSTOMER_CREATED: {
    'payload.name': {
      context: 'personal',
      subjectField: 'aggregateId',
    },
    'payload.location': {
      context: 'personal',
      subjectField: 'aggregateId',
      fallback: '[no location]',
    },
  },
};

describe('createFallbackHandler', () => {
  describe('applyFallbacks', () => {
    test('replaces encrypted fields with default fallback', () => {
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
        expect(result.payload.name).toBe('[deleted]');
        expect(result.payload.location).toBe('[no location]');
      });
    });

    test('uses custom default fallback', () => {
      const handler = createFallbackHandler(schema, '[redacted]');
      const event = {
        type: 'CUSTOMER_CREATED',
        aggregateId: 'cust-1',
        payload: {
          name: { __encrypted: true },
        },
      };

      return handler.applyFallbacks(event).then((result) => {
        expect(result.payload.name).toBe('[redacted]');
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
