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
});
