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

  test('subscribes to events, __system, and __replay topics', () => {
    const context = {
      projectionHandler: {
        projectEvent: vi.fn(() => vi.fn()),
        setReadModelReplayState: vi.fn(),
        projectEventForReadModel: vi.fn(() => vi.fn()),
      },
      replayHandler: {
        handleReplayComplete: vi.fn(),
        handleReplayCancelled: vi.fn(),
      },
      readModels: {},
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
        expect(mockEmitter.on).toHaveBeenCalledWith(
          '__replay',
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
        setReadModelReplayState: vi.fn(),
        projectEventForReadModel: vi.fn(() => vi.fn()),
      },
      replayHandler: {
        handleReplayComplete: vi.fn(),
        handleReplayCancelled: vi.fn(),
      },
      readModels: {},
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

  test('__system handler with global SET_REPLAY_STATE updates inReplay', () => {
    const mockProjectFn = vi.fn();
    const context = {
      projectionHandler: {
        projectEvent: vi.fn().mockReturnValue(mockProjectFn),
        setReadModelReplayState: vi.fn(),
        projectEventForReadModel: vi.fn(() => vi.fn()),
      },
      replayHandler: {
        handleReplayComplete: vi.fn(),
        handleReplayCancelled: vi.fn(),
      },
      readModels: {},
    };

    return readModelEventBusMqEmitter({ mqName: 'test-mq' })(context).then(
      () => {
        // Set replay to true (global - no readModel)
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

  test('__system handler with per-read-model SET_REPLAY_STATE calls setReadModelReplayState', () => {
    const context = {
      projectionHandler: {
        projectEvent: vi.fn(() => vi.fn()),
        setReadModelReplayState: vi.fn(),
        projectEventForReadModel: vi.fn(() => vi.fn()),
      },
      replayHandler: {
        handleReplayComplete: vi.fn(),
        handleReplayCancelled: vi.fn(),
      },
      readModels: {},
    };

    return readModelEventBusMqEmitter({ mqName: 'test-mq' })(context).then(
      () => {
        const cb = vi.fn();
        mockHandlers['__system'](
          {
            payload: {
              correlationId: 'corr-1',
              event: {
                type: 'SET_REPLAY_STATE',
                state: true,
                readModel: 'items',
              },
            },
          },
          cb,
        );

        expect(
          context.projectionHandler.setReadModelReplayState,
        ).toHaveBeenCalledWith('items', true);
        expect(cb).toHaveBeenCalled();
      },
    );
  });

  test('__system handler with REPLAY_EVENTS_DONE calls replayHandler.handleReplayComplete', () => {
    const context = {
      projectionHandler: {
        projectEvent: vi.fn(() => vi.fn()),
        setReadModelReplayState: vi.fn(),
        projectEventForReadModel: vi.fn(() => vi.fn()),
      },
      replayHandler: {
        handleReplayComplete: vi.fn(),
        handleReplayCancelled: vi.fn(),
      },
      readModels: {},
    };

    return readModelEventBusMqEmitter({ mqName: 'test-mq' })(context).then(
      () => {
        const cb = vi.fn();
        mockHandlers['__system'](
          {
            payload: {
              correlationId: 'corr-1',
              event: { type: 'REPLAY_EVENTS_DONE', readModel: 'items' },
            },
          },
          cb,
        );

        expect(context.replayHandler.handleReplayComplete).toHaveBeenCalledWith(
          'items',
          'corr-1',
        );
        expect(cb).toHaveBeenCalled();
      },
    );
  });

  test('__system handler with REPLAY_CANCELLED calls replayHandler.handleReplayCancelled', () => {
    const context = {
      projectionHandler: {
        projectEvent: vi.fn(() => vi.fn()),
        setReadModelReplayState: vi.fn(),
        projectEventForReadModel: vi.fn(() => vi.fn()),
      },
      replayHandler: {
        handleReplayComplete: vi.fn(),
        handleReplayCancelled: vi.fn(),
      },
      readModels: {},
    };

    return readModelEventBusMqEmitter({ mqName: 'test-mq' })(context).then(
      () => {
        const cb = vi.fn();
        mockHandlers['__system'](
          {
            payload: {
              correlationId: 'corr-1',
              event: { type: 'REPLAY_CANCELLED', readModel: 'orders' },
            },
          },
          cb,
        );

        expect(
          context.replayHandler.handleReplayCancelled,
        ).toHaveBeenCalledWith('orders', 'corr-1');
        expect(cb).toHaveBeenCalled();
      },
    );
  });

  test('__replay handler calls projectEventForReadModel for known read model', () => {
    const mockProjectForRM = vi.fn();
    const context = {
      projectionHandler: {
        projectEvent: vi.fn(() => vi.fn()),
        setReadModelReplayState: vi.fn(),
        projectEventForReadModel: vi.fn().mockReturnValue(mockProjectForRM),
      },
      replayHandler: {
        handleReplayComplete: vi.fn(),
        handleReplayCancelled: vi.fn(),
      },
      readModels: { items: { projections: {} } },
    };

    return readModelEventBusMqEmitter({ mqName: 'test-mq' })(context).then(
      () => {
        const event = { type: 'ITEM_CREATED', timestamp: 100 };
        const cb = vi.fn();
        mockHandlers['__replay'](
          {
            payload: {
              correlationId: 'corr-1',
              targetReadModel: 'items',
              event,
            },
          },
          cb,
        );

        expect(
          context.projectionHandler.projectEventForReadModel,
        ).toHaveBeenCalledWith('corr-1', 'items');
        expect(mockProjectForRM).toHaveBeenCalledWith(event);
        expect(cb).toHaveBeenCalled();
      },
    );
  });

  test('__replay handler ignores events for unknown read models', () => {
    const context = {
      projectionHandler: {
        projectEvent: vi.fn(() => vi.fn()),
        setReadModelReplayState: vi.fn(),
        projectEventForReadModel: vi.fn(() => vi.fn()),
      },
      replayHandler: {
        handleReplayComplete: vi.fn(),
        handleReplayCancelled: vi.fn(),
      },
      readModels: { items: { projections: {} } },
    };

    return readModelEventBusMqEmitter({ mqName: 'test-mq' })(context).then(
      () => {
        const event = { type: 'ORDER_CREATED', timestamp: 100 };
        const cb = vi.fn();
        mockHandlers['__replay'](
          {
            payload: {
              correlationId: 'corr-1',
              targetReadModel: 'unknown-rm',
              event,
            },
          },
          cb,
        );

        expect(
          context.projectionHandler.projectEventForReadModel,
        ).not.toHaveBeenCalled();
        expect(cb).toHaveBeenCalled();
      },
    );
  });

  test('__replay handler ignores events with non-matching targetEndpointName', () => {
    const mockProjectForRM = vi.fn();
    const context = {
      projectionHandler: {
        projectEvent: vi.fn(() => vi.fn()),
        setReadModelReplayState: vi.fn(),
        projectEventForReadModel: vi.fn().mockReturnValue(mockProjectForRM),
      },
      replayHandler: {
        handleReplayComplete: vi.fn(),
        handleReplayCancelled: vi.fn(),
      },
      endpointName: 'customers-service',
      readModels: { overview: { projections: {} } },
    };

    return readModelEventBusMqEmitter({ mqName: 'test-mq' })(context).then(
      () => {
        const event = { type: 'ORDER_CREATED', timestamp: 100 };
        const cb = vi.fn();
        mockHandlers['__replay'](
          {
            payload: {
              correlationId: 'corr-1',
              targetReadModel: 'overview',
              event,
              targetEndpointName: 'orders-service',
            },
          },
          cb,
        );

        expect(
          context.projectionHandler.projectEventForReadModel,
        ).not.toHaveBeenCalled();
        expect(cb).toHaveBeenCalled();
      },
    );
  });

  test('__replay handler processes events with matching targetEndpointName', () => {
    const mockProjectForRM = vi.fn();
    const context = {
      projectionHandler: {
        projectEvent: vi.fn(() => vi.fn()),
        setReadModelReplayState: vi.fn(),
        projectEventForReadModel: vi.fn().mockReturnValue(mockProjectForRM),
      },
      replayHandler: {
        handleReplayComplete: vi.fn(),
        handleReplayCancelled: vi.fn(),
      },
      endpointName: 'orders-service',
      readModels: { overview: { projections: {} } },
    };

    return readModelEventBusMqEmitter({ mqName: 'test-mq' })(context).then(
      () => {
        const event = { type: 'ORDER_CREATED', timestamp: 100 };
        const cb = vi.fn();
        mockHandlers['__replay'](
          {
            payload: {
              correlationId: 'corr-1',
              targetReadModel: 'overview',
              event,
              targetEndpointName: 'orders-service',
            },
          },
          cb,
        );

        expect(
          context.projectionHandler.projectEventForReadModel,
        ).toHaveBeenCalledWith('corr-1', 'overview');
        expect(mockProjectForRM).toHaveBeenCalledWith(event);
        expect(cb).toHaveBeenCalled();
      },
    );
  });

  test('__replay handler processes events without targetEndpointName (backward compat)', () => {
    const mockProjectForRM = vi.fn();
    const context = {
      projectionHandler: {
        projectEvent: vi.fn(() => vi.fn()),
        setReadModelReplayState: vi.fn(),
        projectEventForReadModel: vi.fn().mockReturnValue(mockProjectForRM),
      },
      replayHandler: {
        handleReplayComplete: vi.fn(),
        handleReplayCancelled: vi.fn(),
      },
      endpointName: 'orders-service',
      readModels: { overview: { projections: {} } },
    };

    return readModelEventBusMqEmitter({ mqName: 'test-mq' })(context).then(
      () => {
        const event = { type: 'ORDER_CREATED', timestamp: 100 };
        const cb = vi.fn();
        mockHandlers['__replay'](
          {
            payload: {
              correlationId: 'corr-1',
              targetReadModel: 'overview',
              event,
            },
          },
          cb,
        );

        expect(
          context.projectionHandler.projectEventForReadModel,
        ).toHaveBeenCalledWith('corr-1', 'overview');
        expect(mockProjectForRM).toHaveBeenCalledWith(event);
        expect(cb).toHaveBeenCalled();
      },
    );
  });

  test('inReplay starts as false', () => {
    const mockProjectFn = vi.fn();
    const context = {
      projectionHandler: {
        projectEvent: vi.fn().mockReturnValue(mockProjectFn),
        setReadModelReplayState: vi.fn(),
        projectEventForReadModel: vi.fn(() => vi.fn()),
      },
      replayHandler: {
        handleReplayComplete: vi.fn(),
        handleReplayCancelled: vi.fn(),
      },
      readModels: {},
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
