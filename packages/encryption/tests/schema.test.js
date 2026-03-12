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
  test('returns schema with event type lookups', () => {
    const schema = defineEncryptionSchema({
      events: {
        CUSTOMER_CREATED: {
          'payload.name': {
            context: 'personal',
            subjectField: 'aggregateId',
          },
        },
      },
    });
    expect(schema.CUSTOMER_CREATED).toBeDefined();
    expect(schema.CUSTOMER_CREATED['payload.name'].context).toBe('personal');
  });

  test('throws if field missing context', () => {
    expect(() =>
      defineEncryptionSchema({
        events: {
          CUSTOMER_CREATED: {
            'payload.name': { subjectField: 'aggregateId' },
          },
        },
      }),
    ).toThrow("missing 'context'");
  });

  test('throws if field missing subjectField', () => {
    expect(() =>
      defineEncryptionSchema({
        events: {
          CUSTOMER_CREATED: {
            'payload.name': { context: 'personal' },
          },
        },
      }),
    ).toThrow("missing 'subjectField'");
  });

  test('accepts schema with multiple event types', () => {
    const result = defineEncryptionSchema({
      events: {
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
      },
    });
    expect(Object.keys(result)).toHaveLength(2);
  });

  test('accepts empty schema', () => {
    const result = defineEncryptionSchema({});
    expect(Object.keys(result)).toHaveLength(0);
  });

  test('accepts shared field definitions across event types', () => {
    const sharedField = {
      context: 'personal',
      subjectField: 'aggregateId',
    };
    const result = defineEncryptionSchema({
      events: {
        CUSTOMER_CREATED: { 'payload.name': sharedField },
        CUSTOMER_UPDATED: { 'payload.name': sharedField },
      },
    });
    expect(result.CUSTOMER_CREATED['payload.name']).toBe(
      result.CUSTOMER_UPDATED['payload.name'],
    );
  });

  describe('getForgottenText', () => {
    test('returns global default when no overrides', () => {
      const schema = defineEncryptionSchema({ events: {} });
      expect(schema.getForgottenText('name', 'personal')).toBe('[deleted]');
    });

    test('returns custom global default', () => {
      const schema = defineEncryptionSchema({
        defaults: { forgottenText: '[redacted]' },
        events: {},
      });
      expect(schema.getForgottenText('name', 'personal')).toBe('[redacted]');
    });

    test('returns context-level override', () => {
      const schema = defineEncryptionSchema({
        contexts: {
          personal: { forgottenText: '[personal data removed]' },
        },
        events: {},
      });
      expect(schema.getForgottenText('name', 'personal')).toBe(
        '[personal data removed]',
      );
    });

    test('returns field-level override over context-level', () => {
      const schema = defineEncryptionSchema({
        contexts: {
          personal: {
            forgottenText: '[personal data removed]',
            fields: {
              location: { forgottenText: '[location removed]' },
            },
          },
        },
        events: {},
      });
      expect(schema.getForgottenText('location', 'personal')).toBe(
        '[location removed]',
      );
      // Other fields fall back to context level
      expect(schema.getForgottenText('name', 'personal')).toBe(
        '[personal data removed]',
      );
    });

    test('is not enumerable', () => {
      const schema = defineEncryptionSchema({ events: {} });
      expect(Object.keys(schema)).not.toContain('getForgottenText');
    });
  });

  describe('getUnauthorizedText', () => {
    test('returns global default when no overrides', () => {
      const schema = defineEncryptionSchema({ events: {} });
      expect(schema.getUnauthorizedText('name', 'personal')).toBe(
        '[restricted]',
      );
    });

    test('returns custom global default', () => {
      const schema = defineEncryptionSchema({
        defaults: { unauthorizedText: '[no access]' },
        events: {},
      });
      expect(schema.getUnauthorizedText('name', 'personal')).toBe(
        '[no access]',
      );
    });

    test('returns context-level override', () => {
      const schema = defineEncryptionSchema({
        contexts: {
          financial: { unauthorizedText: '[financial data hidden]' },
        },
        events: {},
      });
      expect(schema.getUnauthorizedText('balance', 'financial')).toBe(
        '[financial data hidden]',
      );
    });

    test('is not enumerable', () => {
      const schema = defineEncryptionSchema({ events: {} });
      expect(Object.keys(schema)).not.toContain('getUnauthorizedText');
    });
  });
});
