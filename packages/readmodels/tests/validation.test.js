import { describe, test, expect } from 'vitest';
import { ValidationError, AuthorizationError } from '../validation.js';

describe('ValidationError', () => {
  test('is an instance of Error', () => {
    const err = new ValidationError('test message');
    expect(err).toBeInstanceOf(Error);
  });

  test('has correct name', () => {
    const err = new ValidationError('test message');
    expect(err.name).toBe('ValidationError');
  });

  test('has correct message', () => {
    const err = new ValidationError('test message');
    expect(err.message).toBe('test message');
  });
});

describe('AuthorizationError', () => {
  test('is an instance of Error', () => {
    const err = new AuthorizationError('auth failed');
    expect(err).toBeInstanceOf(Error);
  });

  test('has correct name', () => {
    const err = new AuthorizationError('auth failed');
    expect(err.name).toBe('AuthorizationError');
  });

  test('has correct message', () => {
    const err = new AuthorizationError('auth failed');
    expect(err.message).toBe('auth failed');
  });
});
