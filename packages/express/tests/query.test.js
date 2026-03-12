import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@lazyapps/logger', () => {
  const getLogger = vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debugBare: vi.fn(),
  });
  return { getLogger };
});

const { createApiHandler } = await import('../readmodels/query.js');

const mockReq = (body = {}, params = {}, auth = undefined) => ({
  body,
  params,
  auth,
  headers: {},
  cookies: {},
});

const mockRes = () => {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  res.sendStatus = vi.fn().mockReturnValue(res);
  return res;
};

describe('createApiHandler (query)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('calls resolver with correct arguments and returns 200 with data', () => {
    const mockPerRequest = vi.fn().mockReturnValue('per-request-storage');
    const context = {
      storage: { perRequest: mockPerRequest },
    };
    const resolver = vi.fn().mockResolvedValue([{ id: 1 }]);
    const handler = createApiHandler(context)('items', {}, 'all', resolver);
    const req = mockReq(
      { correlationId: 'corr-1', filter: 'active' },
      {},
      { sub: 'user1' },
    );
    const res = mockRes();

    return handler(req, res).then(() => {
      expect(mockPerRequest).toHaveBeenCalledWith('corr-1');
      expect(resolver).toHaveBeenCalledWith(
        'per-request-storage',
        { correlationId: 'corr-1', filter: 'active' },
        { sub: 'user1' },
        'corr-1',
      );
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith([{ id: 1 }]);
    });
  });

  test('returns 400 on ValidationError', () => {
    const mockPerRequest = vi.fn().mockReturnValue('per-request-storage');
    const context = {
      storage: { perRequest: mockPerRequest },
    };
    const err = new Error('validation failed');
    err.name = 'ValidationError';
    const resolver = vi.fn().mockRejectedValue(err);
    const handler = createApiHandler(context)('items', {}, 'all', resolver);
    const req = mockReq({ correlationId: 'corr-1' });
    const res = mockRes();

    return handler(req, res).then(() => {
      expect(res.sendStatus).toHaveBeenCalledWith(400);
    });
  });

  test('returns 403 on AuthorizationError', () => {
    const mockPerRequest = vi.fn().mockReturnValue('per-request-storage');
    const context = {
      storage: { perRequest: mockPerRequest },
    };
    const err = new Error('not authorized');
    err.name = 'AuthorizationError';
    const resolver = vi.fn().mockRejectedValue(err);
    const handler = createApiHandler(context)('items', {}, 'all', resolver);
    const req = mockReq({ correlationId: 'corr-1' });
    const res = mockRes();

    return handler(req, res).then(() => {
      expect(res.sendStatus).toHaveBeenCalledWith(403);
    });
  });

  test('returns 403 when resolver throws AuthorizationError synchronously', () => {
    const mockPerRequest = vi.fn().mockReturnValue('per-request-storage');
    const context = {
      storage: { perRequest: mockPerRequest },
    };
    const err = new Error('not authorized');
    err.name = 'AuthorizationError';
    const resolver = vi.fn().mockImplementation(() => {
      throw err;
    });
    const handler = createApiHandler(context)('items', {}, 'all', resolver);
    const req = mockReq({ correlationId: 'corr-1' });
    const res = mockRes();

    return handler(req, res).then(() => {
      expect(res.sendStatus).toHaveBeenCalledWith(403);
    });
  });

  test('returns 500 when resolver rejects', () => {
    const mockPerRequest = vi.fn().mockReturnValue('per-request-storage');
    const context = {
      storage: { perRequest: mockPerRequest },
    };
    const resolver = vi.fn().mockRejectedValue(new Error('query failed'));
    const handler = createApiHandler(context)('items', {}, 'all', resolver);
    const req = mockReq({ correlationId: 'corr-1' });
    const res = mockRes();

    return handler(req, res).then(() => {
      expect(res.sendStatus).toHaveBeenCalledWith(500);
    });
  });

  test('uses jwtScopeMapper when available in context', () => {
    const mockDecrypt = vi.fn().mockResolvedValue({ id: 1, name: 'Alice' });
    const mockPerRequest = vi.fn().mockReturnValue('per-request-storage');
    const jwtScopeMapper = vi.fn().mockReturnValue({
      roles: ['mapped-role'],
      identity: 'mapped-identity',
    });
    const context = {
      storage: { perRequest: mockPerRequest },
      encryptionQueryDecryptor: { decrypt: mockDecrypt },
      jwtScopeMapper,
    };
    const resolver = vi.fn().mockResolvedValue({ id: 1, name: 'encrypted' });
    const handler = createApiHandler(context)('items', {}, 'all', resolver);
    const auth = { sub: 'user-1', roles: ['original-role'] };
    const req = mockReq({ correlationId: 'corr-1' }, {}, auth);
    const res = mockRes();

    return handler(req, res).then(() => {
      expect(jwtScopeMapper).toHaveBeenCalledWith(auth);
      expect(mockDecrypt).toHaveBeenCalledWith(
        { id: 1, name: 'encrypted' },
        { roles: ['mapped-role'], identity: 'mapped-identity' },
      );
      expect(res.status).toHaveBeenCalledWith(200);
    });
  });

  test('falls back to auth.roles and encryptionRole without jwtScopeMapper', () => {
    const mockDecrypt = vi.fn().mockResolvedValue({ id: 1, name: 'Alice' });
    const mockPerRequest = vi.fn().mockReturnValue('per-request-storage');
    const context = {
      storage: { perRequest: mockPerRequest },
      encryptionQueryDecryptor: { decrypt: mockDecrypt },
      encryptionRole: 'service',
    };
    const resolver = vi.fn().mockResolvedValue({ id: 1, name: 'encrypted' });
    const handler = createApiHandler(context)('items', {}, 'all', resolver);
    const req = mockReq({ correlationId: 'corr-1' });
    const res = mockRes();

    return handler(req, res).then(() => {
      expect(mockDecrypt).toHaveBeenCalledWith(
        { id: 1, name: 'encrypted' },
        { roles: ['service'], identity: undefined },
      );
    });
  });

  test('decrypts array results with jwtScopeMapper', () => {
    const mockDecrypt = vi
      .fn()
      .mockResolvedValueOnce({ id: 1, name: 'Alice' })
      .mockResolvedValueOnce({ id: 2, name: 'Bob' });
    const mockPerRequest = vi.fn().mockReturnValue('per-request-storage');
    const jwtScopeMapper = vi.fn().mockReturnValue({
      roles: ['admin'],
      identity: 'user-1',
    });
    const context = {
      storage: { perRequest: mockPerRequest },
      encryptionQueryDecryptor: { decrypt: mockDecrypt },
      jwtScopeMapper,
    };
    const resolver = vi.fn().mockResolvedValue([
      { id: 1, name: 'enc1' },
      { id: 2, name: 'enc2' },
    ]);
    const handler = createApiHandler(context)('items', {}, 'all', resolver);
    const auth = { sub: 'user-1', roles: ['admin'] };
    const req = mockReq({ correlationId: 'corr-1' }, {}, auth);
    const res = mockRes();

    return handler(req, res).then(() => {
      expect(mockDecrypt).toHaveBeenCalledTimes(2);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith([
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
      ]);
    });
  });
});
