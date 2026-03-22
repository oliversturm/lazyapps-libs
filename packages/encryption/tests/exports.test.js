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

  test('exports createForgetMixin', () => {
    expect(encryption.createForgetMixin).toBeTypeOf('function');
    const mixin = encryption.createForgetMixin({
      personal: { roles: ['admin'], autoForget: true },
    });
    expect(mixin.commands).toHaveProperty('FORGET_SUBJECT');
    expect(mixin.commands).toHaveProperty('FORGET_SUBJECT_CONTEXT');
    expect(mixin.projections).toHaveProperty('SUBJECT_FORGOTTEN');
  });

  test('exports getNestedValue', () => {
    expect(encryption.getNestedValue).toBeTypeOf('function');
  });

  test('exports setNestedValue', () => {
    expect(encryption.setNestedValue).toBeTypeOf('function');
  });
});
