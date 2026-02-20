import { describe, test, expect, vi } from 'vitest';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

const encryption = await import('../index.js');

describe('index.js exports', () => {
  test('exports createEncryption', () => {
    expect(encryption.createEncryption).toBeTypeOf('function');
  });

  test('exports defineEncryptionSchema', () => {
    expect(encryption.defineEncryptionSchema).toBeTypeOf('function');
  });

  test('exports inMemoryKeyStore', () => {
    expect(encryption.inMemoryKeyStore).toBeTypeOf('function');
  });

  test('exports mongoKeyStore', () => {
    expect(encryption.mongoKeyStore).toBeTypeOf('function');
  });

  test('exports vaultKeyStore', () => {
    expect(encryption.vaultKeyStore).toBeTypeOf('function');
  });

  test('exports appRole', () => {
    expect(encryption.appRole).toBeTypeOf('function');
  });

  test('exports subjectLifecycleAggregate', () => {
    expect(encryption.subjectLifecycleAggregate).toBeTypeOf('object');
    expect(encryption.subjectLifecycleAggregate.commands).toHaveProperty(
      'FORGET_SUBJECT',
    );
    expect(encryption.subjectLifecycleAggregate.projections).toHaveProperty(
      'SUBJECT_FORGOTTEN',
    );
  });

  test('exports createForgetSubjectEndpoints', () => {
    expect(encryption.createForgetSubjectEndpoints).toBeTypeOf('function');
  });

  test('exports getNestedValue', () => {
    expect(encryption.getNestedValue).toBeTypeOf('function');
  });

  test('exports setNestedValue', () => {
    expect(encryption.setNestedValue).toBeTypeOf('function');
  });
});
