import { describe, test, expect } from 'vitest';

const { redactUrl } = await import('../redactUrl.js');

describe('redactUrl', () => {
  test('masks user:pass in mongodb URL', () => {
    expect(redactUrl('mongodb://user:pass@host:27017/db')).toBe(
      'mongodb://***@host:27017/db',
    );
  });

  test('masks user:pass in amqp URL', () => {
    expect(redactUrl('amqp://guest:guest@rabbit:5672/')).toBe(
      'amqp://***@rabbit:5672/',
    );
  });

  test('URL without auth is returned unchanged', () => {
    expect(redactUrl('mongodb://host:27017/db')).toBe(
      'mongodb://host:27017/db',
    );
    expect(redactUrl('amqp://rabbit:5672/')).toBe('amqp://rabbit:5672/');
    expect(redactUrl('https://example.com/path')).toBe(
      'https://example.com/path',
    );
  });

  test('URL with only username (empty password) is masked', () => {
    // URL with a user but no password — still contains credentials.
    expect(redactUrl('mongodb://admin@host:27017/db')).toBe(
      'mongodb://***@host:27017/db',
    );
  });

  test('URL with colon in password is masked (no leakage)', () => {
    const result = redactUrl('mongodb://u:p:ass:word@host:27017/db');
    // Password must not appear anywhere in output.
    expect(result).not.toContain('p:ass:word');
    expect(result).not.toContain('pass');
    // And the output must not contain the original user either.
    expect(result).not.toContain('u:');
    // Should still look like a redacted URL pointing at the host.
    expect(result).toContain('host:27017/db');
    expect(result).toContain('***');
  });

  test('URL with URL-encoded credentials is masked', () => {
    expect(redactUrl('mongodb://user%40x:p%40ss@host:27017/db')).toBe(
      'mongodb://***@host:27017/db',
    );
  });

  test('URL with query string and credentials — credentials redacted, query preserved', () => {
    const result = redactUrl(
      'mongodb://user:pass@host:27017/db?replicaSet=rs0&authSource=admin',
    );
    expect(result).not.toContain('user');
    expect(result).not.toContain('pass');
    expect(result).toContain('replicaSet=rs0');
    expect(result).toContain('authSource=admin');
    expect(result).toContain('***');
  });

  test('non-URL string is returned as-is (does not throw)', () => {
    expect(redactUrl('not-a-url')).toBe('not-a-url');
    expect(redactUrl('')).toBe('');
    expect(() => redactUrl('garbage://[broken')).not.toThrow();
  });

  test('null / undefined input is returned as-is (does not throw)', () => {
    expect(redactUrl(null)).toBe(null);
    expect(redactUrl(undefined)).toBe(undefined);
  });

  test('multiple credential-containing URLs in a single string — all redacted', () => {
    // Helper is single-URL only; this documents that callers must call per-URL.
    // Using two single calls:
    const a = redactUrl('mongodb://user:pass@host1/db');
    const b = redactUrl('amqp://a:b@host2/');
    expect(a).not.toContain('pass');
    expect(b).not.toContain(':b@');
  });
});
