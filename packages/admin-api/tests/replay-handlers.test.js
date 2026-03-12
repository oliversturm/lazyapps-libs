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
  let publishFn;

  beforeEach(() => {
    vi.clearAllMocks();
    publishFn = vi.fn();
    context = {
      eventBus: {
        publishAdminInstruction: vi.fn().mockReturnValue(publishFn),
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

  test('publishes start_replay instruction via event bus', () => {
    const handler = startReplayHandler(context);
    const req = mockReq({ readModel: 'items', fromTimestamp: 100 });
    const res = mockRes();

    handler(req, res);

    expect(context.eventBus.publishAdminInstruction).toHaveBeenCalledWith(
      'test-corr-id',
    );
    expect(publishFn).toHaveBeenCalledWith({
      type: 'start_replay',
      readModel: 'items',
      fromTimestamp: 100,
      toTimestamp: null,
      targetServiceId: undefined,
      correlationId: 'test-corr-id',
    });
    expect(res.json).toHaveBeenCalledWith({
      status: 'started',
      readModel: 'items',
      correlationId: 'test-corr-id',
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

    expect(context.eventBus.publishAdminInstruction).toHaveBeenCalledWith(
      'custom-corr',
    );
    expect(publishFn).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'start_replay',
        readModel: 'items',
        correlationId: 'custom-corr',
      }),
    );
  });

  test('defaults fromTimestamp to 0 and toTimestamp to null', () => {
    const handler = startReplayHandler(context);
    const req = mockReq({ readModel: 'items' });
    const res = mockRes();

    handler(req, res);

    expect(publishFn).toHaveBeenCalledWith(
      expect.objectContaining({
        fromTimestamp: 0,
        toTimestamp: null,
      }),
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

    expect(publishFn).toHaveBeenCalledWith(
      expect.objectContaining({
        fromTimestamp: 100,
        toTimestamp: 500,
      }),
    );
  });

  test('passes targetServiceId when provided', () => {
    const handler = startReplayHandler(context);
    const req = mockReq({
      readModel: 'items',
      targetServiceId: 'orders-service',
    });
    const res = mockRes();

    handler(req, res);

    expect(publishFn).toHaveBeenCalledWith(
      expect.objectContaining({
        targetServiceId: 'orders-service',
      }),
    );
  });
});

describe('replayStatusHandler', () => {
  test('returns in_progress when replay state is set', () => {
    const projectionHandler = {
      getReadModelReplayStates: vi.fn().mockReturnValue({
        items: true,
      }),
      getReadModelTerminalStatus: vi.fn().mockReturnValue(null),
    };
    const context = { projectionHandler };
    const handler = replayStatusHandler(context);
    const req = mockReq({}, { readModel: 'items' });
    const res = mockRes();

    handler(req, res);

    expect(res.json).toHaveBeenCalledWith({
      readModel: 'items',
      status: 'in_progress',
    });
  });

  test('returns idle status for unknown read model', () => {
    const projectionHandler = {
      getReadModelReplayStates: vi.fn().mockReturnValue({}),
      getReadModelTerminalStatus: vi.fn().mockReturnValue(null),
    };
    const context = { projectionHandler };
    const handler = replayStatusHandler(context);
    const req = mockReq({}, { readModel: 'unknown' });
    const res = mockRes();

    handler(req, res);

    expect(res.json).toHaveBeenCalledWith({
      readModel: 'unknown',
      status: 'idle',
    });
  });

  test('returns completed status after REPLAY_EVENTS_DONE', () => {
    const projectionHandler = {
      getReadModelReplayStates: vi.fn().mockReturnValue({}),
      getReadModelTerminalStatus: vi.fn().mockReturnValue('completed'),
    };
    const context = { projectionHandler };
    const handler = replayStatusHandler(context);
    const req = mockReq({}, { readModel: 'items' });
    const res = mockRes();

    handler(req, res);

    expect(res.json).toHaveBeenCalledWith({
      readModel: 'items',
      status: 'completed',
    });
  });

  test('returns cancelled status after REPLAY_CANCELLED', () => {
    const projectionHandler = {
      getReadModelReplayStates: vi.fn().mockReturnValue({}),
      getReadModelTerminalStatus: vi.fn().mockReturnValue('cancelled'),
    };
    const context = { projectionHandler };
    const handler = replayStatusHandler(context);
    const req = mockReq({}, { readModel: 'items' });
    const res = mockRes();

    handler(req, res);

    expect(res.json).toHaveBeenCalledWith({
      readModel: 'items',
      status: 'cancelled',
    });
  });

  test('in_progress takes precedence over terminal status', () => {
    const projectionHandler = {
      getReadModelReplayStates: vi.fn().mockReturnValue({ items: true }),
      getReadModelTerminalStatus: vi.fn().mockReturnValue('completed'),
    };
    const context = { projectionHandler };
    const handler = replayStatusHandler(context);
    const req = mockReq({}, { readModel: 'items' });
    const res = mockRes();

    handler(req, res);

    expect(res.json).toHaveBeenCalledWith({
      readModel: 'items',
      status: 'in_progress',
    });
  });
});

describe('cancelReplayHandler', () => {
  let context;
  let publishFn;

  beforeEach(() => {
    vi.clearAllMocks();
    publishFn = vi.fn();
    context = {
      eventBus: {
        publishAdminInstruction: vi.fn().mockReturnValue(publishFn),
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

  test('publishes cancel_replay instruction via event bus', () => {
    const handler = cancelReplayHandler(context);
    const req = mockReq({ readModel: 'items' });
    const res = mockRes();

    handler(req, res);

    expect(context.eventBus.publishAdminInstruction).toHaveBeenCalledWith(
      'test-corr-id',
    );
    expect(publishFn).toHaveBeenCalledWith({
      type: 'cancel_replay',
      readModel: 'items',
      correlationId: 'test-corr-id',
    });
    expect(res.json).toHaveBeenCalledWith({
      status: 'cancelling',
      readModel: 'items',
    });
  });

  test('uses correlationId from request body when provided', () => {
    const handler = cancelReplayHandler(context);
    const req = mockReq({
      readModel: 'items',
      correlationId: 'custom-corr',
    });
    const res = mockRes();

    handler(req, res);

    expect(context.eventBus.publishAdminInstruction).toHaveBeenCalledWith(
      'custom-corr',
    );
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
