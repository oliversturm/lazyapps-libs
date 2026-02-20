import { describe, test, expect } from 'vitest';

const { getNestedValue, setNestedValue } = await import('../pathUtils.js');

describe('getNestedValue', () => {
  test('gets value with single-segment path', () => {
    const obj = { name: 'Alice' };
    expect(getNestedValue(obj, 'name')).toBe('Alice');
  });

  test('gets value with multi-segment path', () => {
    const obj = { payload: { name: 'Alice' } };
    expect(getNestedValue(obj, 'payload.name')).toBe('Alice');
  });

  test('gets value with deep path', () => {
    const obj = { payload: { address: { street: '123 Main St' } } };
    expect(getNestedValue(obj, 'payload.address.street')).toBe('123 Main St');
  });

  test('returns undefined for non-existent intermediate', () => {
    const obj = { payload: {} };
    expect(getNestedValue(obj, 'payload.missing.field')).toBeUndefined();
  });

  test('returns undefined for completely missing path', () => {
    const obj = {};
    expect(getNestedValue(obj, 'a.b.c')).toBeUndefined();
  });

  test('returns falsy value when root is null-ish', () => {
    expect(getNestedValue(null, 'a')).toBeNull();
    expect(getNestedValue(undefined, 'a')).toBeUndefined();
  });
});

describe('setNestedValue', () => {
  test('sets value with single-segment path', () => {
    const obj = {};
    const result = setNestedValue(obj, 'name', 'Alice');
    expect(result.name).toBe('Alice');
    expect(result).toBe(obj);
  });

  test('sets value with multi-segment path', () => {
    const obj = { payload: {} };
    setNestedValue(obj, 'payload.name', 'Alice');
    expect(obj.payload.name).toBe('Alice');
  });

  test('sets value with deep path', () => {
    const obj = { payload: { address: {} } };
    setNestedValue(obj, 'payload.address.street', '123 Main St');
    expect(obj.payload.address.street).toBe('123 Main St');
  });

  test('creates intermediate objects when they do not exist', () => {
    const obj = {};
    setNestedValue(obj, 'payload.address.street', '123 Main St');
    expect(obj.payload.address.street).toBe('123 Main St');
    expect(typeof obj.payload).toBe('object');
    expect(typeof obj.payload.address).toBe('object');
  });

  test('overwrites existing value', () => {
    const obj = { payload: { name: 'Alice' } };
    setNestedValue(obj, 'payload.name', 'Bob');
    expect(obj.payload.name).toBe('Bob');
  });

  test('returns the original object', () => {
    const obj = { a: 1 };
    const result = setNestedValue(obj, 'b', 2);
    expect(result).toBe(obj);
  });
});
