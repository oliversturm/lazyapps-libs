import { describe, test, expect } from 'vitest';
import { randomBytes } from 'node:crypto';

const { encryptValue, decryptValue } = await import('../fieldEncryption.js');

const testKey = randomBytes(32);

describe('encryptValue / decryptValue primitives', () => {
  test('round-trips with empty string', () => {
    const encrypted = encryptValue(testKey, '');
    const decrypted = decryptValue(testKey, encrypted);
    expect(decrypted).toBe('');
  });

  test('round-trips numeric value 42 as string "42"', () => {
    const encrypted = encryptValue(testKey, 42);
    const decrypted = decryptValue(testKey, encrypted);
    expect(decrypted).toBe('42');
  });

  test('round-trips boolean true as string "true"', () => {
    const encrypted = encryptValue(testKey, true);
    const decrypted = decryptValue(testKey, encrypted);
    expect(decrypted).toBe('true');
  });

  test('decryptValue with tampered data field throws', () => {
    const encrypted = encryptValue(testKey, 'secret');
    const tampered = {
      ...encrypted,
      data: Buffer.from('tampered-data').toString('base64'),
    };
    expect(() => decryptValue(testKey, tampered)).toThrow();
  });

  test('decryptValue with tampered tag field throws', () => {
    const encrypted = encryptValue(testKey, 'secret');
    const tampered = {
      ...encrypted,
      tag: Buffer.from('0000000000000000').toString('base64'),
    };
    expect(() => decryptValue(testKey, tampered)).toThrow();
  });

  test('decryptValue with wrong key throws', () => {
    const encrypted = encryptValue(testKey, 'secret');
    const wrongKey = randomBytes(32);
    expect(() => decryptValue(wrongKey, encrypted)).toThrow();
  });

  test('encryptValue produces unique IVs per call', () => {
    const enc1 = encryptValue(testKey, 'same value');
    const enc2 = encryptValue(testKey, 'same value');
    expect(enc1.iv).not.toBe(enc2.iv);
    expect(enc1.data).not.toBe(enc2.data);
  });

  test('decryptValue with mismatched algorithm throws', () => {
    const encrypted = encryptValue(testKey, 'secret');
    const tampered = { ...encrypted, alg: 'aes-128-gcm' };
    expect(() => decryptValue(testKey, tampered)).toThrow();
  });
});
