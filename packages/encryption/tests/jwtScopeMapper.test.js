import { describe, test, expect, vi } from 'vitest';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

const { directRoleMapper, scopeClaimMapper, customMapper } =
  await import('../jwtScopeMapper.js');

describe('directRoleMapper', () => {
  test('extracts roles and identity from auth', () => {
    const mapper = directRoleMapper();
    const result = mapper({ roles: ['admin', 'support'], sub: 'user-42' });
    expect(result).toEqual({
      roles: ['admin', 'support'],
      identity: 'user-42',
    });
  });

  test('returns empty roles when auth has no roles', () => {
    const mapper = directRoleMapper();
    const result = mapper({ sub: 'user-1' });
    expect(result).toEqual({ roles: [], identity: 'user-1' });
  });

  test('handles null auth', () => {
    const mapper = directRoleMapper();
    const result = mapper(null);
    expect(result).toEqual({ roles: [], identity: null });
  });

  test('handles undefined auth', () => {
    const mapper = directRoleMapper();
    const result = mapper(undefined);
    expect(result).toEqual({ roles: [], identity: undefined });
  });
});

describe('scopeClaimMapper', () => {
  test('reads from default claim name', () => {
    const mapper = scopeClaimMapper();
    const result = mapper({
      lazyAppsEncryptionScopes: ['admin'],
      sub: 'user-1',
    });
    expect(result).toEqual({ roles: ['admin'], identity: 'user-1' });
  });

  test('reads from custom claim name', () => {
    const mapper = scopeClaimMapper('encScopes');
    const result = mapper({
      encScopes: ['support', 'self'],
      sub: 'user-2',
    });
    expect(result).toEqual({
      roles: ['support', 'self'],
      identity: 'user-2',
    });
  });

  test('returns empty roles when claim is missing', () => {
    const mapper = scopeClaimMapper('missingClaim');
    const result = mapper({ sub: 'user-1' });
    expect(result).toEqual({ roles: [], identity: 'user-1' });
  });

  test('handles null auth', () => {
    const mapper = scopeClaimMapper();
    const result = mapper(null);
    expect(result).toEqual({ roles: [], identity: null });
  });
});

describe('customMapper', () => {
  test('calls custom function with auth object', () => {
    const fn = vi.fn().mockReturnValue({
      roles: ['custom-role'],
      identity: 'custom-id',
    });
    const mapper = customMapper(fn);
    const auth = { sub: 'user-1', customField: 'value' };
    const result = mapper(auth);
    expect(fn).toHaveBeenCalledWith(auth);
    expect(result).toEqual({
      roles: ['custom-role'],
      identity: 'custom-id',
    });
  });

  test('defaults roles to empty array if function omits it', () => {
    const mapper = customMapper(() => ({ identity: 'id-1' }));
    const result = mapper({ sub: 'user-1' });
    expect(result).toEqual({ roles: [], identity: 'id-1' });
  });

  test('passes empty object when auth is undefined', () => {
    const fn = vi.fn().mockReturnValue({ roles: [], identity: undefined });
    const mapper = customMapper(fn);
    mapper(undefined);
    expect(fn).toHaveBeenCalledWith({});
  });

  test('passes empty object when auth is null', () => {
    const fn = vi.fn().mockReturnValue({ roles: [], identity: undefined });
    const mapper = customMapper(fn);
    mapper(null);
    expect(fn).toHaveBeenCalledWith({});
  });
});
