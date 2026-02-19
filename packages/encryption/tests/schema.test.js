import { describe, test, expect, vi } from 'vitest';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

const { defineEncryptionSchema } = await import('../schema.js');

describe('defineEncryptionSchema', () => {
  test('returns validated schema', () => {
    const schemaDef = {
      CUSTOMER_CREATED: {
        'payload.name': {
          context: 'personal',
          subjectField: 'aggregateId',
        },
      },
    };
    const result = defineEncryptionSchema(schemaDef);
    expect(result).toBe(schemaDef);
  });

  test('throws if field missing context', () => {
    expect(() =>
      defineEncryptionSchema({
        CUSTOMER_CREATED: {
          'payload.name': { subjectField: 'aggregateId' },
        },
      }),
    ).toThrow("missing 'context'");
  });

  test('throws if field missing subjectField', () => {
    expect(() =>
      defineEncryptionSchema({
        CUSTOMER_CREATED: {
          'payload.name': { context: 'personal' },
        },
      }),
    ).toThrow("missing 'subjectField'");
  });

  test('accepts schema with multiple event types', () => {
    const result = defineEncryptionSchema({
      CUSTOMER_CREATED: {
        'payload.name': {
          context: 'personal',
          subjectField: 'aggregateId',
        },
      },
      ORDER_CREATED: {
        'payload.text': {
          context: 'order-details',
          subjectField: 'payload.customerId',
        },
      },
    });
    expect(Object.keys(result)).toHaveLength(2);
  });

  test('accepts empty schema', () => {
    const result = defineEncryptionSchema({});
    expect(result).toEqual({});
  });

  test('accepts shared field definitions across event types', () => {
    const sharedField = {
      context: 'personal',
      subjectField: 'aggregateId',
    };
    const result = defineEncryptionSchema({
      CUSTOMER_CREATED: { 'payload.name': sharedField },
      CUSTOMER_UPDATED: { 'payload.name': sharedField },
    });
    expect(result.CUSTOMER_CREATED['payload.name']).toBe(
      result.CUSTOMER_UPDATED['payload.name'],
    );
  });
});
