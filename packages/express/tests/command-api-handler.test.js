import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@lazyapps/logger', () => {
  const getLogger = vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debugBare: vi.fn(),
  });
  return { getLogger, safeStringify: (obj) => JSON.stringify(obj) };
});

const { createApiHandler } =
  await import('../command-receiver/command-api-handler.js');

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

const testAggregates = {
  thing: {
    commands: {
      CREATE: () => {},
      UPDATE: () => {},
    },
  },
};

describe('createApiHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('returns 400 when command is missing', () => {
    const handleCommand = vi.fn();
    const handler = createApiHandler({
      aggregates: testAggregates,
      handleCommand,
    });
    const req = mockReq({ aggregateName: 'thing', aggregateId: '1' });
    const res = mockRes();

    handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith('Missing field');
  });

  test('returns 400 when aggregateName is missing', () => {
    const handleCommand = vi.fn();
    const handler = createApiHandler({
      aggregates: testAggregates,
      handleCommand,
    });
    const req = mockReq({ command: 'CREATE', aggregateId: '1' });
    const res = mockRes();

    handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith('Missing field');
  });

  test('returns 400 when aggregateId is missing', () => {
    const handleCommand = vi.fn();
    const handler = createApiHandler({
      aggregates: testAggregates,
      handleCommand,
    });
    const req = mockReq({ command: 'CREATE', aggregateName: 'thing' });
    const res = mockRes();

    handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith('Missing field');
  });

  test('returns 400 for invalid aggregate name', () => {
    const handleCommand = vi.fn();
    const handler = createApiHandler({
      aggregates: testAggregates,
      handleCommand,
    });
    const req = mockReq({
      command: 'CREATE',
      aggregateName: 'nonexistent',
      aggregateId: '1',
    });
    const res = mockRes();

    handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith('Invalid aggregate name');
  });

  test('returns 400 for invalid command name', () => {
    const handleCommand = vi.fn();
    const handler = createApiHandler({
      aggregates: testAggregates,
      handleCommand,
    });
    const req = mockReq({
      command: 'NONEXISTENT',
      aggregateName: 'thing',
      aggregateId: '1',
    });
    const res = mockRes();

    handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith('Invalid command name');
  });

  test('returns 200 when handleCommand resolves', () => {
    const handleCommand = vi.fn().mockResolvedValue();
    const handler = createApiHandler({
      aggregates: testAggregates,
      handleCommand,
    });
    const req = mockReq({
      command: 'CREATE',
      aggregateName: 'thing',
      aggregateId: '1',
      payload: { name: 'test' },
      correlationId: 'corr-1',
    });
    const res = mockRes();

    return handler(req, res).then(() => {
      expect(res.sendStatus).toHaveBeenCalledWith(200);
    });
  });

  test('returns 400 on ValidationError', () => {
    const err = new Error('validation failed');
    err.name = 'ValidationError';
    const handleCommand = vi.fn().mockRejectedValue(err);
    const handler = createApiHandler({
      aggregates: testAggregates,
      handleCommand,
    });
    const req = mockReq({
      command: 'CREATE',
      aggregateName: 'thing',
      aggregateId: '1',
      payload: {},
      correlationId: 'corr-1',
    });
    const res = mockRes();

    return handler(req, res).then(() => {
      expect(res.sendStatus).toHaveBeenCalledWith(400);
    });
  });

  test('returns 403 on AuthorizationError', () => {
    const err = new Error('not authorized');
    err.name = 'AuthorizationError';
    const handleCommand = vi.fn().mockRejectedValue(err);
    const handler = createApiHandler({
      aggregates: testAggregates,
      handleCommand,
    });
    const req = mockReq({
      command: 'CREATE',
      aggregateName: 'thing',
      aggregateId: '1',
      payload: {},
      correlationId: 'corr-1',
    });
    const res = mockRes();

    return handler(req, res).then(() => {
      expect(res.sendStatus).toHaveBeenCalledWith(403);
    });
  });

  test('returns 409 on SubjectForgottenError', () => {
    const err = Object.assign(
      new Error('Cannot modify subject whose personal data has been forgotten'),
      { name: 'SubjectForgottenError', code: 'SUBJECT_FORGOTTEN' },
    );
    const handleCommand = vi.fn().mockRejectedValue(err);
    const handler = createApiHandler({
      aggregates: testAggregates,
      handleCommand,
    });
    const req = mockReq({
      command: 'UPDATE',
      aggregateName: 'thing',
      aggregateId: '1',
      payload: {},
      correlationId: 'corr-1',
    });
    const res = mockRes();

    return handler(req, res).then(() => {
      expect(res.status).toHaveBeenCalledWith(409);
      expect(res.json).toHaveBeenCalledWith({
        error: 'SubjectForgotten',
        message: 'Cannot modify subject whose personal data has been forgotten',
      });
    });
  });

  test('returns 500 on unknown error', () => {
    const handleCommand = vi
      .fn()
      .mockRejectedValue(new Error('something broke'));
    const handler = createApiHandler({
      aggregates: testAggregates,
      handleCommand,
    });
    const req = mockReq({
      command: 'CREATE',
      aggregateName: 'thing',
      aggregateId: '1',
      payload: {},
      correlationId: 'corr-1',
    });
    const res = mockRes();

    return handler(req, res).then(() => {
      expect(res.sendStatus).toHaveBeenCalledWith(500);
    });
  });
});
