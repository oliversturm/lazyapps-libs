import { describe, test, expect, vi } from 'vitest';

vi.mock('@lazyapps/logger', () => {
  const getLogger = vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  });
  return { getLogger, safeStringify: (o) => JSON.stringify(o) };
});

const { sanitizeMongoOperators } = await import('../readmodels/sanitize.js');

describe('sanitizeMongoOperators', () => {
  test('strips $-prefixed operators at top level', () => {
    expect(sanitizeMongoOperators({ $gt: 1, name: 'x' })).toEqual({
      name: 'x',
    });
    expect(sanitizeMongoOperators({ $ne: null, a: 1 })).toEqual({ a: 1 });
    expect(sanitizeMongoOperators({ $where: 'x', a: 1 })).toEqual({ a: 1 });
    expect(sanitizeMongoOperators({ $regex: 'x', a: 1 })).toEqual({ a: 1 });
    expect(sanitizeMongoOperators({ $or: [1, 2], a: 1 })).toEqual({ a: 1 });
  });

  test('strips $-prefixed operators nested in objects', () => {
    expect(
      sanitizeMongoOperators({
        filter: { $gt: 5, value: 1 },
        name: 'x',
      }),
    ).toEqual({ filter: { value: 1 }, name: 'x' });

    expect(
      sanitizeMongoOperators({
        a: { b: { $ne: null, c: 2 } },
      }),
    ).toEqual({ a: { b: { c: 2 } } });
  });

  test('strips $-prefixed operators inside array elements', () => {
    expect(
      sanitizeMongoOperators({
        items: [{ $ne: null }, { keep: 1 }, { $gt: 5, also: 2 }],
      }),
    ).toEqual({ items: [{}, { keep: 1 }, { also: 2 }] });
  });

  test('strips keys containing dots', () => {
    expect(sanitizeMongoOperators({ 'a.b': 1, c: 2 })).toEqual({ c: 2 });
    expect(
      sanitizeMongoOperators({
        nested: { 'x.y': 'bad', good: 'ok' },
      }),
    ).toEqual({ nested: { good: 'ok' } });
  });

  test('preserves primitives', () => {
    expect(sanitizeMongoOperators({ a: 1, b: 'x', c: true, d: null })).toEqual({
      a: 1,
      b: 'x',
      c: true,
      d: null,
    });
  });

  test('preserves arrays of primitives', () => {
    expect(sanitizeMongoOperators({ list: [1, 2, 3] })).toEqual({
      list: [1, 2, 3],
    });
    expect(sanitizeMongoOperators({ tags: ['a', 'b'] })).toEqual({
      tags: ['a', 'b'],
    });
  });

  test('preserves well-formed nested structures', () => {
    expect(
      sanitizeMongoOperators({
        user: { id: 1, name: 'Alice', address: { city: 'Berlin' } },
      }),
    ).toEqual({
      user: { id: 1, name: 'Alice', address: { city: 'Berlin' } },
    });
  });

  test('empty object input → empty output', () => {
    expect(sanitizeMongoOperators({})).toEqual({});
  });

  test('null / undefined input → unchanged', () => {
    expect(sanitizeMongoOperators(null)).toBe(null);
    expect(sanitizeMongoOperators(undefined)).toBe(undefined);
  });

  test('returns a NEW object (does not mutate input)', () => {
    const input = { $gt: 5, a: 1 };
    const out = sanitizeMongoOperators(input);
    expect(out).not.toBe(input);
    // Input remains untouched.
    expect(input).toEqual({ $gt: 5, a: 1 });
  });

  test('returns new arrays (does not mutate)', () => {
    const input = { items: [{ $ne: null }, { a: 1 }] };
    const out = sanitizeMongoOperators(input);
    expect(out.items).not.toBe(input.items);
    expect(input.items[0]).toEqual({ $ne: null });
  });

  describe('prototype pollution defense (SEC-23 extension)', () => {
    test('strips __proto__ at top level and does not pollute the result', () => {
      // Use JSON.parse so __proto__ lands as an OWN enumerable key (which is
      // how it would arrive from an HTTP JSON body), not as a prototype link.
      const input = JSON.parse('{"__proto__": {"isAdmin": true}, "ok": 1}');
      const result = sanitizeMongoOperators(input);

      expect(result.ok).toBe(1);
      expect(result.isAdmin).toBeUndefined();
      // `__proto__` is an inherited accessor on Object.prototype, so
      // `'__proto__' in result` is always true for any object that inherits
      // from Object.prototype. The meaningful check is that there's no OWN
      // data property named `__proto__` that could carry attacker payload.
      expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(
        false,
      );
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
      // And no cross-object pollution (a fresh object must not inherit).
      const probe = {};
      expect(probe.isAdmin).toBeUndefined();
    });

    test('strips constructor key', () => {
      const input = { constructor: { payload: 'evil' }, ok: 1 };
      const result = sanitizeMongoOperators(input);
      expect(result.ok).toBe(1);
      // Either the key is removed entirely or its own-property value is not
      // the attacker-supplied object. We require the strict version: removed.
      expect(Object.prototype.hasOwnProperty.call(result, 'constructor')).toBe(
        false,
      );
      // Built-in `constructor` lookup still resolves to Object via prototype.
      expect(result.constructor).toBe(Object);
    });

    test('strips prototype key', () => {
      const input = { prototype: 'x', ok: 1 };
      const result = sanitizeMongoOperators(input);
      expect(result.ok).toBe(1);
      expect(Object.prototype.hasOwnProperty.call(result, 'prototype')).toBe(
        false,
      );
    });

    test('strips __proto__ at arbitrary depth', () => {
      const input = JSON.parse(
        '{"a": {"b": {"__proto__": {"x": 1}, "keep": 2}}}',
      );
      const result = sanitizeMongoOperators(input);
      expect(result.a.b.keep).toBe(2);
      expect(result.a.b.x).toBeUndefined();
      expect(
        Object.prototype.hasOwnProperty.call(result.a.b, '__proto__'),
      ).toBe(false);
      expect(Object.getPrototypeOf(result.a.b)).toBe(Object.prototype);
      expect(Object.getPrototypeOf(result.a)).toBe(Object.prototype);
    });

    test('strips __proto__ inside array elements', () => {
      const input = JSON.parse(
        '{"items": [{"__proto__": {"x": 1}, "keep": 2}, {"also": 3}]}',
      );
      const result = sanitizeMongoOperators(input);
      expect(result.items[0].keep).toBe(2);
      expect(result.items[0].x).toBeUndefined();
      expect(
        Object.prototype.hasOwnProperty.call(result.items[0], '__proto__'),
      ).toBe(false);
      expect(Object.getPrototypeOf(result.items[0])).toBe(Object.prototype);
      expect(result.items[1].also).toBe(3);
    });

    test('strips constructor and prototype at depth', () => {
      const input = {
        a: { constructor: { bad: 1 }, ok: 1 },
        b: { prototype: 'x', ok: 2 },
      };
      const result = sanitizeMongoOperators(input);
      expect(result.a.ok).toBe(1);
      expect(result.b.ok).toBe(2);
      expect(
        Object.prototype.hasOwnProperty.call(result.a, 'constructor'),
      ).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(result.b, 'prototype')).toBe(
        false,
      );
    });

    test('cross-request global pollution probe', () => {
      // If the sanitizer ever walked into `__proto__` and recursed, it could
      // inadvertently pollute Object.prototype. Build a request body that
      // would trigger such behavior and verify the global prototype is clean
      // before and after.
      const markerBefore = Object.prototype.polluted;
      const input = JSON.parse('{"__proto__": {"polluted": "yes"}}');
      sanitizeMongoOperators(input);
      expect(Object.prototype.polluted).toBe(markerBefore);
      expect({}.polluted).toBeUndefined();
    });
  });

  test('handles a realistic injection payload', () => {
    expect(
      sanitizeMongoOperators({
        correlationId: 'corr-1',
        name: { $gt: '' },
        items: [{ $ne: null }],
        'a.b': 1,
        clean: 'ok',
      }),
    ).toEqual({
      correlationId: 'corr-1',
      name: {},
      items: [{}],
      clean: 'ok',
    });
  });
});
