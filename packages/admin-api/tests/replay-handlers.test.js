import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('nanoid', () => ({
  nanoid: vi.fn().mockReturnValue('test-corr-id'),
}));

const {
  startReplayHandler,
  replayStatusHandler,
  cancelReplayHandler,
  setCommandReplayStateHandler,
} = await import('../replay-handlers.js');

const mockReq = (body = {}, params = {}) => ({
  body,
  params,
  auth: undefined,
});

const mockRes = () => {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.sendStatus = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  return res;
};

describe('startReplayHandler', () => {
  let context;

  beforeEach(() => {
    vi.clearAllMocks();
    context = {
      replayHandler: {
        getReplayStatus: vi.fn().mockReturnValue({ status: 'idle' }),
        startReplay: vi.fn().mockResolvedValue(),
      },
    };
  });

  test('returns 400 if readModel is missing', () => {
    const handler = startReplayHandler(context);
    const req = mockReq({});
    const res = mockRes();

    handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'readModel is required',
    });
  });

  test('returns 409 if replay already in progress', () => {
    context.replayHandler.getReplayStatus.mockReturnValue({
      status: 'in_progress',
    });
    const handler = startReplayHandler(context);
    const req = mockReq({ readModel: 'items' });
    const res = mockRes();

    handler(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringMatching(/already/) }),
    );
  });

  test('starts replay and responds with started status', () => {
    const handler = startReplayHandler(context);
    const req = mockReq({ readModel: 'items', fromTimestamp: 100 });
    const res = mockRes();

    handler(req, res);

    expect(context.replayHandler.startReplay).toHaveBeenCalledWith(
      'test-corr-id',
      'items',
      100,
      null,
    );
    expect(res.json).toHaveBeenCalledWith({
      status: 'started',
      readModel: 'items',
    });
  });

  test('uses correlationId from request body when provided', () => {
    const handler = startReplayHandler(context);
    const req = mockReq({
      readModel: 'items',
      correlationId: 'custom-corr',
    });
    const res = mockRes();

    handler(req, res);

    expect(context.replayHandler.startReplay).toHaveBeenCalledWith(
      'custom-corr',
      'items',
      0,
      null,
    );
  });

  test('defaults fromTimestamp to 0 and toTimestamp to null', () => {
    const handler = startReplayHandler(context);
    const req = mockReq({ readModel: 'items' });
    const res = mockRes();

    handler(req, res);

    expect(context.replayHandler.startReplay).toHaveBeenCalledWith(
      'test-corr-id',
      'items',
      0,
      null,
    );
  });

  test('passes toTimestamp when provided', () => {
    const handler = startReplayHandler(context);
    const req = mockReq({
      readModel: 'items',
      fromTimestamp: 100,
      toTimestamp: 500,
    });
    const res = mockRes();

    handler(req, res);

    expect(context.replayHandler.startReplay).toHaveBeenCalledWith(
      'test-corr-id',
      'items',
      100,
      500,
    );
  });

  test('catches background replay errors without crashing', () => {
    context.replayHandler.startReplay.mockRejectedValue(
      new Error('stream error'),
    );
    const handler = startReplayHandler(context);
    const req = mockReq({ readModel: 'items' });
    const res = mockRes();

    handler(req, res);

    // Response is sent before the error occurs
    expect(res.json).toHaveBeenCalledWith({
      status: 'started',
      readModel: 'items',
    });
  });
});

describe('replayStatusHandler', () => {
  test('returns replay status for the given read model', () => {
    const context = {
      replayHandler: {
        getReplayStatus: vi.fn().mockReturnValue({
          status: 'in_progress',
          readModel: 'items',
          eventsPublished: 500,
          eventsTotal: 1000,
        }),
      },
    };
    const handler = replayStatusHandler(context);
    const req = mockReq({}, { readModel: 'items' });
    const res = mockRes();

    handler(req, res);

    expect(context.replayHandler.getReplayStatus).toHaveBeenCalledWith('items');
    expect(res.json).toHaveBeenCalledWith({
      status: 'in_progress',
      readModel: 'items',
      eventsPublished: 500,
      eventsTotal: 1000,
    });
  });

  test('returns idle status for unknown read model', () => {
    const context = {
      replayHandler: {
        getReplayStatus: vi
          .fn()
          .mockReturnValue({ status: 'idle', readModel: 'unknown' }),
      },
    };
    const handler = replayStatusHandler(context);
    const req = mockReq({}, { readModel: 'unknown' });
    const res = mockRes();

    handler(req, res);

    expect(res.json).toHaveBeenCalledWith({
      status: 'idle',
      readModel: 'unknown',
    });
  });
});

describe('cancelReplayHandler', () => {
  let context;

  beforeEach(() => {
    vi.clearAllMocks();
    context = {
      replayHandler: {
        cancelReplay: vi.fn().mockResolvedValue(),
      },
    };
  });

  test('returns 400 if readModel is missing', () => {
    const handler = cancelReplayHandler(context);
    const req = mockReq({});
    const res = mockRes();

    handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'readModel is required',
    });
  });

  test('cancels replay and responds with cancelling status', () => {
    const handler = cancelReplayHandler(context);
    const req = mockReq({ readModel: 'items' });
    const res = mockRes();

    return handler(req, res).then(() => {
      expect(context.replayHandler.cancelReplay).toHaveBeenCalledWith(
        'test-corr-id',
        'items',
      );
      expect(res.json).toHaveBeenCalledWith({
        status: 'cancelling',
        readModel: 'items',
      });
    });
  });

  test('uses correlationId from request body when provided', () => {
    const handler = cancelReplayHandler(context);
    const req = mockReq({
      readModel: 'items',
      correlationId: 'custom-corr',
    });
    const res = mockRes();

    return handler(req, res).then(() => {
      expect(context.replayHandler.cancelReplay).toHaveBeenCalledWith(
        'custom-corr',
        'items',
      );
    });
  });

  test('returns 500 on error', () => {
    context.replayHandler.cancelReplay.mockRejectedValue(
      new Error('cancel failed'),
    );
    const handler = cancelReplayHandler(context);
    const req = mockReq({ readModel: 'items' });
    const res = mockRes();

    return handler(req, res).then(() => {
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Error: cancel failed',
      });
    });
  });
});

describe('setCommandReplayStateHandler', () => {
  let context;

  beforeEach(() => {
    vi.clearAllMocks();
    context = {
      eventBus: {
        publishReplayState: vi
          .fn()
          .mockReturnValue(vi.fn().mockReturnValue(true)),
      },
    };
  });

  test('returns 400 if state is missing', () => {
    const handler = setCommandReplayStateHandler(context);
    const req = mockReq({});
    const res = mockRes();

    handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'state (boolean) is required',
    });
  });

  test('returns 400 if state is not a boolean', () => {
    const handler = setCommandReplayStateHandler(context);
    const req = mockReq({ state: 'true' });
    const res = mockRes();

    handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'state (boolean) is required',
    });
  });

  test('sets command replay state to true', () => {
    const handler = setCommandReplayStateHandler(context);
    const req = mockReq({ state: true });
    const res = mockRes();

    return handler(req, res).then(() => {
      expect(context.eventBus.publishReplayState).toHaveBeenCalledWith(
        'test-corr-id',
      );
      expect(
        context.eventBus.publishReplayState('test-corr-id'),
      ).toHaveBeenCalledWith(true);
      expect(res.json).toHaveBeenCalledWith({
        status: 'ok',
        commandReplayState: true,
      });
    });
  });

  test('sets command replay state to false', () => {
    const handler = setCommandReplayStateHandler(context);
    const req = mockReq({ state: false });
    const res = mockRes();

    return handler(req, res).then(() => {
      expect(context.eventBus.publishReplayState).toHaveBeenCalledWith(
        'test-corr-id',
      );
      expect(
        context.eventBus.publishReplayState('test-corr-id'),
      ).toHaveBeenCalledWith(false);
      expect(res.json).toHaveBeenCalledWith({
        status: 'ok',
        commandReplayState: false,
      });
    });
  });

  test('returns 500 on error', () => {
    context.eventBus.publishReplayState.mockReturnValue(
      vi.fn().mockImplementation(() => {
        throw new Error('bus error');
      }),
    );
    const handler = setCommandReplayStateHandler(context);
    const req = mockReq({ state: true });
    const res = mockRes();

    return handler(req, res).then(() => {
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Error: bus error',
      });
    });
  });
});
