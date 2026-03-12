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

const { startCatchupHandler, cancelCatchupHandler, getCatchupStatusHandler } =
  await import('../catchup-handlers.js');

const mockReq = (body = {}, params = {}) => ({
  body,
  params,
});

const mockRes = () => {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.sendStatus = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  return res;
};

describe('startCatchupHandler', () => {
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

  test('publishes start_catchup instruction via event bus', () => {
    const handler = startCatchupHandler(context);
    const req = mockReq(
      { fromTimestamp: 100, serviceId: 'svc-1' },
      { readModelName: 'items' },
    );
    const res = mockRes();

    handler(req, res);

    expect(context.eventBus.publishAdminInstruction).toHaveBeenCalledWith(
      'test-corr-id',
    );
    expect(publishFn).toHaveBeenCalledWith({
      type: 'start_catchup',
      readModel: 'items',
      fromTimestamp: 100,
      serviceId: 'svc-1',
      correlationId: 'test-corr-id',
    });
    expect(res.json).toHaveBeenCalledWith({
      status: 'started',
      readModel: 'items',
      correlationId: 'test-corr-id',
    });
  });

  test('defaults fromTimestamp to 0', () => {
    const handler = startCatchupHandler(context);
    const req = mockReq({}, { readModelName: 'items' });
    const res = mockRes();

    handler(req, res);

    expect(publishFn).toHaveBeenCalledWith(
      expect.objectContaining({ fromTimestamp: 0 }),
    );
  });
});

describe('cancelCatchupHandler', () => {
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

  test('publishes cancel_catchup instruction via event bus', () => {
    const handler = cancelCatchupHandler(context);
    const req = mockReq({}, { readModelName: 'items' });
    const res = mockRes();

    handler(req, res);

    expect(context.eventBus.publishAdminInstruction).toHaveBeenCalledWith(
      'test-corr-id',
    );
    expect(publishFn).toHaveBeenCalledWith({
      type: 'cancel_catchup',
      readModel: 'items',
      correlationId: 'test-corr-id',
    });
    expect(res.json).toHaveBeenCalledWith({
      status: 'cancelling',
      readModel: 'items',
    });
  });
});

describe('getCatchupStatusHandler', () => {
  test('returns in_progress when replay state is set', () => {
    const projectionHandler = {
      getReadModelReplayStates: vi.fn().mockReturnValue({ items: true }),
      getReadModelTerminalStatus: vi.fn().mockReturnValue(null),
    };
    const context = { projectionHandler };
    const handler = getCatchupStatusHandler(context);
    const req = mockReq({}, { readModelName: 'items' });
    const res = mockRes();

    handler(req, res);

    expect(res.json).toHaveBeenCalledWith({
      readModel: 'items',
      status: 'in_progress',
    });
  });

  test('returns idle when no replay state and no terminal status', () => {
    const projectionHandler = {
      getReadModelReplayStates: vi.fn().mockReturnValue({}),
      getReadModelTerminalStatus: vi.fn().mockReturnValue(null),
    };
    const context = { projectionHandler };
    const handler = getCatchupStatusHandler(context);
    const req = mockReq({}, { readModelName: 'items' });
    const res = mockRes();

    handler(req, res);

    expect(res.json).toHaveBeenCalledWith({
      readModel: 'items',
      status: 'idle',
    });
  });

  test('returns completed status after CATCHUP_EVENTS_DONE', () => {
    const projectionHandler = {
      getReadModelReplayStates: vi.fn().mockReturnValue({}),
      getReadModelTerminalStatus: vi.fn().mockReturnValue('completed'),
    };
    const context = { projectionHandler };
    const handler = getCatchupStatusHandler(context);
    const req = mockReq({}, { readModelName: 'items' });
    const res = mockRes();

    handler(req, res);

    expect(res.json).toHaveBeenCalledWith({
      readModel: 'items',
      status: 'completed',
    });
  });

  test('returns cancelled status after CATCHUP_CANCELLED', () => {
    const projectionHandler = {
      getReadModelReplayStates: vi.fn().mockReturnValue({}),
      getReadModelTerminalStatus: vi.fn().mockReturnValue('cancelled'),
    };
    const context = { projectionHandler };
    const handler = getCatchupStatusHandler(context);
    const req = mockReq({}, { readModelName: 'items' });
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
    const handler = getCatchupStatusHandler(context);
    const req = mockReq({}, { readModelName: 'items' });
    const res = mockRes();

    handler(req, res);

    expect(res.json).toHaveBeenCalledWith({
      readModel: 'items',
      status: 'in_progress',
    });
  });
});
