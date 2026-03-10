import { describe, test, expect, vi } from 'vitest';
import { adminTokenAuth, validateAdminToken } from '../adminTokenAuth.js';

describe('adminTokenAuth middleware', () => {
  const createRes = () => {
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    return res;
  };

  test('returns 401 when no Authorization header', () => {
    const middleware = adminTokenAuth('secret-token');
    const req = { headers: {} };
    const res = createRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
    expect(next).not.toHaveBeenCalled();
  });

  test('returns 401 when wrong token', () => {
    const middleware = adminTokenAuth('secret-token');
    const req = { headers: { authorization: 'Bearer wrong-token' } };
    const res = createRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
    expect(next).not.toHaveBeenCalled();
  });

  test('calls next() when correct Bearer token', () => {
    const middleware = adminTokenAuth('secret-token');
    const req = { headers: { authorization: 'Bearer secret-token' } };
    const res = createRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('passes through when no token configured (undefined)', () => {
    const middleware = adminTokenAuth(undefined);
    const req = { headers: {} };
    const res = createRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('passes through when no token configured (null)', () => {
    const middleware = adminTokenAuth(null);
    const req = { headers: {} };
    const res = createRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  test('returns 401 for non-Bearer auth scheme', () => {
    const middleware = adminTokenAuth('secret-token');
    const req = { headers: { authorization: 'Basic secret-token' } };
    const res = createRes();
    const next = vi.fn();

    middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('validateAdminToken', () => {
  test('returns true when no expected token configured', () => {
    expect(validateAdminToken(undefined, 'any-token')).toBe(true);
    expect(validateAdminToken(null, 'any-token')).toBe(true);
    expect(validateAdminToken(undefined, undefined)).toBe(true);
  });

  test('returns true when tokens match', () => {
    expect(validateAdminToken('secret', 'secret')).toBe(true);
  });

  test('returns false when tokens do not match', () => {
    expect(validateAdminToken('secret', 'wrong')).toBe(false);
  });

  test('returns false when received token is undefined', () => {
    expect(validateAdminToken('secret', undefined)).toBe(false);
  });

  test('returns false when received token is null', () => {
    expect(validateAdminToken('secret', null)).toBe(false);
  });
});
