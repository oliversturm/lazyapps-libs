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

const { adminHandler } = await import('../command-receiver/admin-handler.js');

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

describe('adminHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('returns 400 when no handleAdminCommand in context', () => {
    const handler = adminHandler({});
    const req = mockReq({ correlationId: 'corr-1' }, { command: 'rebuild' });
    const res = mockRes();

    handler(req, res);

    expect(res.sendStatus).toHaveBeenCalledWith(400);
  });

  test('returns 200 when handler resolves', () => {
    const handleAdminCommand = vi.fn().mockResolvedValue();
    const context = { handleAdminCommand };
    const handler = adminHandler(context);
    const req = mockReq(
      { correlationId: 'corr-1', params: { key: 'val' } },
      { command: 'rebuild' },
    );
    req.auth = { sub: 'admin' };
    const res = mockRes();

    return handler(req, res).then(() => {
      expect(handleAdminCommand).toHaveBeenCalledWith(
        context,
        'rebuild',
        { key: 'val' },
        { sub: 'admin' },
        'corr-1',
      );
      expect(res.sendStatus).toHaveBeenCalledWith(200);
    });
  });

  test('returns 500 when handler rejects', () => {
    const handleAdminCommand = vi
      .fn()
      .mockRejectedValue(new Error('admin failed'));
    const context = { handleAdminCommand };
    const handler = adminHandler(context);
    const req = mockReq(
      { correlationId: 'corr-1', params: {} },
      { command: 'rebuild' },
    );
    const res = mockRes();

    return handler(req, res).then(() => {
      expect(res.sendStatus).toHaveBeenCalledWith(500);
    });
  });
});
