import { describe, test, expect, vi } from 'vitest';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

const {
  defaultScopeMapper,
  getScopedRoomName,
  getScopeKey,
  redactPayload,
  createRedactionEngine,
} = await import('../redaction.js');

describe('defaultScopeMapper', () => {
  test('returns empty array for null token', () => {
    expect(defaultScopeMapper(null)).toEqual([]);
  });

  test('returns empty array for undefined token', () => {
    expect(defaultScopeMapper(undefined)).toEqual([]);
  });

  test('extracts scopes from token.scopes', () => {
    const token = { scopes: ['financial', 'personal'] };
    expect(defaultScopeMapper(token)).toEqual(['financial', 'personal']);
  });

  test('extracts scopes from token.encryption_scopes', () => {
    const token = { encryption_scopes: ['personal'] };
    expect(defaultScopeMapper(token)).toEqual(['personal']);
  });

  test('extracts scopes from token.roles as fallback', () => {
    const token = { roles: ['admin', 'user'] };
    expect(defaultScopeMapper(token)).toEqual(['admin', 'user']);
  });

  test('prefers scopes over encryption_scopes', () => {
    const token = { scopes: ['a'], encryption_scopes: ['b'] };
    expect(defaultScopeMapper(token)).toEqual(['a']);
  });

  test('returns sorted scopes', () => {
    const token = { scopes: ['z', 'a', 'm'] };
    expect(defaultScopeMapper(token)).toEqual(['a', 'm', 'z']);
  });

  test('returns empty array when token has no scope fields', () => {
    const token = { sub: 'user-1', iat: 12345 };
    expect(defaultScopeMapper(token)).toEqual([]);
  });

  test('does not mutate original scopes array', () => {
    const original = ['z', 'a'];
    const token = { scopes: original };
    defaultScopeMapper(token);
    expect(original).toEqual(['z', 'a']);
  });
});

describe('getScopedRoomName', () => {
  test('appends sorted scopes to base room', () => {
    expect(getScopedRoomName('ep/rm/res', ['financial', 'personal'])).toBe(
      'ep/rm/res:scopes=financial,personal',
    );
  });

  test('uses scopes=none for empty scopes', () => {
    expect(getScopedRoomName('ep/rm/res', [])).toBe('ep/rm/res:scopes=none');
  });

  test('handles single scope', () => {
    expect(getScopedRoomName('ep/rm/res', ['personal'])).toBe(
      'ep/rm/res:scopes=personal',
    );
  });
});

describe('getScopeKey', () => {
  test('joins scopes with comma', () => {
    expect(getScopeKey(['financial', 'personal'])).toBe('financial,personal');
  });

  test('returns none for empty scopes', () => {
    expect(getScopeKey([])).toBe('none');
  });
});

describe('redactPayload', () => {
  const createMockSchema = () => ({
    getUnauthorizedText: vi.fn(
      (fieldName, contextName) => `[${contextName} restricted]`,
    ),
    getForgottenText: vi.fn(
      (fieldName, contextName) => `[${contextName} deleted]`,
    ),
  });

  const contexts = {
    personal: { roles: ['admin', 'hr'] },
    financial: { roles: ['finance'] },
  };

  test('returns payload unchanged when schema is null', () => {
    const payload = { name: 'Alice', amount: 100 };
    expect(redactPayload(payload, null, contexts, [])).toEqual(payload);
  });

  test('returns payload unchanged when contexts is null', () => {
    const schema = createMockSchema();
    const payload = { name: 'Alice', amount: 100 };
    expect(redactPayload(payload, schema, null, [])).toEqual(payload);
  });

  test('redacts encrypted fields when scopes do not match', () => {
    const schema = createMockSchema();
    const payload = {
      id: '1',
      name: { __encrypted: true, ctx: 'personal', data: 'enc' },
      balance: { __encrypted: true, ctx: 'financial', data: 'enc' },
    };

    const result = redactPayload(payload, schema, contexts, []);

    expect(result.id).toBe('1');
    expect(result.name).toEqual({
      unauthorized: true,
      text: '[personal restricted]',
    });
    expect(result.balance).toEqual({
      unauthorized: true,
      text: '[financial restricted]',
    });
  });

  test('leaves encrypted fields intact when scopes match', () => {
    const schema = createMockSchema();
    const payload = {
      id: '1',
      name: { __encrypted: true, ctx: 'personal', data: 'enc' },
    };

    const result = redactPayload(payload, schema, contexts, ['admin']);

    expect(result.name).toEqual({
      __encrypted: true,
      ctx: 'personal',
      data: 'enc',
    });
  });

  test('partially redacts when scopes cover some contexts', () => {
    const schema = createMockSchema();
    const payload = {
      id: '1',
      name: { __encrypted: true, ctx: 'personal', data: 'enc' },
      balance: { __encrypted: true, ctx: 'financial', data: 'enc' },
    };

    const result = redactPayload(payload, schema, contexts, ['admin']);

    expect(result.name).toEqual({
      __encrypted: true,
      ctx: 'personal',
      data: 'enc',
    });
    expect(result.balance).toEqual({
      unauthorized: true,
      text: '[financial restricted]',
    });
  });

  test('does not redact non-encrypted fields', () => {
    const schema = createMockSchema();
    const payload = { id: '1', status: 'active', count: 42 };

    const result = redactPayload(payload, schema, contexts, []);

    expect(result).toEqual({ id: '1', status: 'active', count: 42 });
  });

  test('handles contexts without roles gracefully', () => {
    const schema = createMockSchema();
    const ctxs = { personal: {} };
    const payload = {
      name: { __encrypted: true, ctx: 'personal', data: 'enc' },
    };

    const result = redactPayload(payload, schema, ctxs, ['admin']);

    expect(result.name).toEqual({
      __encrypted: true,
      ctx: 'personal',
      data: 'enc',
    });
  });

  test('redacts context fields defined in context config', () => {
    const schema = createMockSchema();
    const ctxs = {
      personal: {
        roles: ['admin'],
        fields: { name: {}, email: {} },
      },
    };
    const payload = { id: '1', name: 'Alice', email: 'alice@test.com' };

    const result = redactPayload(payload, schema, ctxs, []);

    expect(result.id).toBe('1');
    expect(result.name).toEqual({
      unauthorized: true,
      text: '[personal restricted]',
    });
    expect(result.email).toEqual({
      unauthorized: true,
      text: '[personal restricted]',
    });
  });

  test('does not redact context fields when scopes match', () => {
    const schema = createMockSchema();
    const ctxs = {
      personal: {
        roles: ['admin'],
        fields: { name: {}, email: {} },
      },
    };
    const payload = { id: '1', name: 'Alice', email: 'alice@test.com' };

    const result = redactPayload(payload, schema, ctxs, ['admin']);

    expect(result).toEqual(payload);
  });
});

describe('createRedactionEngine', () => {
  const createMockSchema = () => ({
    getUnauthorizedText: vi.fn(
      (fieldName, contextName) => `[${contextName} restricted]`,
    ),
    getForgottenText: vi.fn(
      (fieldName, contextName) => `[${contextName} deleted]`,
    ),
  });

  test('creates engine with redact method', () => {
    const engine = createRedactionEngine();
    expect(typeof engine.redact).toBe('function');
  });

  test('passes through payload when no schema/contexts', () => {
    const engine = createRedactionEngine();
    const payload = { name: 'Alice' };

    expect(engine.redact(payload, [])).toEqual(payload);
  });

  test('applies schema-driven redaction', () => {
    const schema = createMockSchema();
    const contexts = { personal: { roles: ['admin'] } };
    const engine = createRedactionEngine({ schema, contexts });

    const payload = {
      readModelName: 'customers',
      name: { __encrypted: true, ctx: 'personal', data: 'enc' },
    };

    const result = engine.redact(payload, []);

    expect(result.name).toEqual({
      unauthorized: true,
      text: '[personal restricted]',
    });
  });

  test('applies custom redaction hook after schema redaction', () => {
    const schema = createMockSchema();
    const contexts = { personal: { roles: ['admin'] } };
    const hook = vi.fn((payload, scopes) => ({
      ...payload,
      computedField: scopes.includes('admin')
        ? payload.computedField
        : '[hidden]',
    }));

    const engine = createRedactionEngine({
      schema,
      contexts,
      redactionHooks: { customers: hook },
    });

    const payload = {
      readModelName: 'customers',
      computedField: 'sensitive',
    };

    const result = engine.redact(payload, []);

    expect(hook).toHaveBeenCalledWith(payload, []);
    expect(result.computedField).toBe('[hidden]');
  });

  test('does not apply hook for non-matching read model', () => {
    const hook = vi.fn();
    const engine = createRedactionEngine({
      redactionHooks: { orders: hook },
    });

    const payload = { readModelName: 'customers', name: 'Alice' };
    engine.redact(payload, []);

    expect(hook).not.toHaveBeenCalled();
  });

  test('applies hook even without schema', () => {
    const hook = vi.fn((payload) => ({ ...payload, extra: 'redacted' }));
    const engine = createRedactionEngine({
      redactionHooks: { customers: hook },
    });

    const payload = { readModelName: 'customers', name: 'Alice' };
    const result = engine.redact(payload, ['admin']);

    expect(hook).toHaveBeenCalledWith(payload, ['admin']);
    expect(result.extra).toBe('redacted');
  });

  test('full scopes receive unredacted payload', () => {
    const schema = createMockSchema();
    const contexts = {
      personal: { roles: ['admin'] },
      financial: { roles: ['finance'] },
    };
    const engine = createRedactionEngine({ schema, contexts });

    const payload = {
      readModelName: 'customers',
      name: { __encrypted: true, ctx: 'personal', data: 'enc' },
      balance: { __encrypted: true, ctx: 'financial', data: 'enc' },
    };

    const result = engine.redact(payload, ['admin', 'finance']);

    expect(result.name).toEqual({
      __encrypted: true,
      ctx: 'personal',
      data: 'enc',
    });
    expect(result.balance).toEqual({
      __encrypted: true,
      ctx: 'financial',
      data: 'enc',
    });
  });

  test('no scopes receive fully redacted payload', () => {
    const schema = createMockSchema();
    const contexts = {
      personal: { roles: ['admin'] },
      financial: { roles: ['finance'] },
    };
    const engine = createRedactionEngine({ schema, contexts });

    const payload = {
      readModelName: 'customers',
      name: { __encrypted: true, ctx: 'personal', data: 'enc' },
      balance: { __encrypted: true, ctx: 'financial', data: 'enc' },
    };

    const result = engine.redact(payload, []);

    expect(result.name).toEqual({
      unauthorized: true,
      text: '[personal restricted]',
    });
    expect(result.balance).toEqual({
      unauthorized: true,
      text: '[financial restricted]',
    });
  });
});
