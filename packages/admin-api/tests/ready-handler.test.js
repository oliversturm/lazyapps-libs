import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { setReadyHandler, getReadyHandler } =
  await import('../ready-handler.js');

const mockReq = (body = {}) => ({ body });

const mockRes = () => {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  return res;
};

describe('setReadyHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('calls setReady(true) when context has setReady', () => {
    const context = { setReady: vi.fn() };
    const handler = setReadyHandler(context);
    const req = mockReq({ correlationId: 'corr-1' });
    const res = mockRes();

    handler(req, res);

    expect(context.setReady).toHaveBeenCalledWith(true);
    expect(res.json).toHaveBeenCalledWith({ status: 'ready' });
  });

  test('responds with note when setReady is not on context', () => {
    const context = {};
    const handler = setReadyHandler(context);
    const req = mockReq({});
    const res = mockRes();

    handler(req, res);

    expect(res.json).toHaveBeenCalledWith({
      status: 'ready',
      note: 'readiness not configured',
    });
  });

  test('works without correlationId in body', () => {
    const context = { setReady: vi.fn() };
    const handler = setReadyHandler(context);
    const req = mockReq({});
    const res = mockRes();

    handler(req, res);

    expect(context.setReady).toHaveBeenCalledWith(true);
    expect(res.json).toHaveBeenCalledWith({ status: 'ready' });
  });
});

describe('getReadyHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('returns ready true when isReady returns true', () => {
    const context = { isReady: () => true };
    const handler = getReadyHandler(context);
    const req = mockReq();
    const res = mockRes();

    handler(req, res);

    expect(res.json).toHaveBeenCalledWith({ ready: true });
  });

  test('returns ready false when isReady returns false', () => {
    const context = { isReady: () => false };
    const handler = getReadyHandler(context);
    const req = mockReq();
    const res = mockRes();

    handler(req, res);

    expect(res.json).toHaveBeenCalledWith({ ready: false });
  });

  test('defaults to ready true when isReady is not on context', () => {
    const context = {};
    const handler = getReadyHandler(context);
    const req = mockReq();
    const res = mockRes();

    handler(req, res);

    expect(res.json).toHaveBeenCalledWith({ ready: true });
  });
});
