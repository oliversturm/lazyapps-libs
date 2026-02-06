import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockHandlers = vi.hoisted(() => ({}));
const mockEmitter = vi.hoisted(() => ({
  emit: vi.fn(),
  on: vi.fn((topic, handler, cb) => {
    mockHandlers[topic] = handler;
    if (cb) cb();
  }),
}));

vi.mock('../mqEmitterRegistry.js', () => ({
  getSharedMqEmitter: vi.fn().mockReturnValue(mockEmitter),
}));

const { readModelEventBusMqEmitter } =
  await import('../readModelEventBusMqEmitter.js');

describe('readModelEventBusMqEmitter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Clear handlers
    Object.keys(mockHandlers).forEach((k) => delete mockHandlers[k]);
    // Re-setup the on mock
    mockEmitter.on.mockImplementation((topic, handler, cb) => {
      mockHandlers[topic] = handler;
      if (cb) cb();
    });
  });

  test('subscribes to events and __system topics', () => {
    const context = {
      projectionHandler: { projectEvent: vi.fn(() => vi.fn()) },
    };

    return readModelEventBusMqEmitter({ mqName: 'test-mq' })(context).then(
      () => {
        expect(mockEmitter.on).toHaveBeenCalledWith(
          'events',
          expect.any(Function),
        );
        expect(mockEmitter.on).toHaveBeenCalledWith(
          '__system',
          expect.any(Function),
        );
      },
    );
  });

  test('events handler calls projectionHandler.projectEvent', () => {
    const mockProjectFn = vi.fn();
    const context = {
      projectionHandler: {
        projectEvent: vi.fn().mockReturnValue(mockProjectFn),
      },
    };

    return readModelEventBusMqEmitter({ mqName: 'test-mq' })(context).then(
      () => {
        const payload = { correlationId: 'corr-1', type: 'CREATED' };
        const cb = vi.fn();
        mockHandlers['events']({ payload }, cb);

        expect(context.projectionHandler.projectEvent).toHaveBeenCalledWith(
          'corr-1',
        );
        expect(mockProjectFn).toHaveBeenCalledWith(payload, false);
        expect(cb).toHaveBeenCalled();
      },
    );
  });

  test('__system handler with SET_REPLAY_STATE updates inReplay', () => {
    const mockProjectFn = vi.fn();
    const context = {
      projectionHandler: {
        projectEvent: vi.fn().mockReturnValue(mockProjectFn),
      },
    };

    return readModelEventBusMqEmitter({ mqName: 'test-mq' })(context).then(
      () => {
        // Set replay to true
        const sysCb = vi.fn();
        mockHandlers['__system'](
          {
            payload: {
              correlationId: 'corr-1',
              event: { type: 'SET_REPLAY_STATE', state: true },
            },
          },
          sysCb,
        );
        expect(sysCb).toHaveBeenCalled();

        // Now send an event - inReplay should be true
        const eventCb = vi.fn();
        const payload = { correlationId: 'corr-2', type: 'REPLAYED' };
        mockHandlers['events']({ payload }, eventCb);

        expect(mockProjectFn).toHaveBeenCalledWith(payload, true);
      },
    );
  });

  test('inReplay starts as false', () => {
    const mockProjectFn = vi.fn();
    const context = {
      projectionHandler: {
        projectEvent: vi.fn().mockReturnValue(mockProjectFn),
      },
    };

    return readModelEventBusMqEmitter({ mqName: 'test-mq' })(context).then(
      () => {
        const payload = { correlationId: 'corr-1', type: 'TEST' };
        mockHandlers['events']({ payload }, vi.fn());

        expect(mockProjectFn).toHaveBeenCalledWith(payload, false);
      },
    );
  });
});
