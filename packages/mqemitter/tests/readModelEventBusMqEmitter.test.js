import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
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
    // Clear handlers (set to undefined; re-registered by mockImplementation below)
    Object.keys(mockHandlers).forEach((k) => {
      mockHandlers[k] = undefined;
    });
    // Re-setup the on mock
    mockEmitter.on.mockImplementation((topic, handler, cb) => {
      mockHandlers[topic] = handler;
      if (cb) cb();
    });
  });

  test('subscribes to events, __replay, __catchup, and __admin topics', () => {
    const context = {
      projectionHandler: {
        projectEvent: vi.fn(() => vi.fn()),
        projectEventForReadModel: vi.fn(() => vi.fn()),
        projectCatchupEventForReadModel: vi.fn(() => vi.fn()),
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
          '__replay',
          expect.any(Function),
        );
        expect(mockEmitter.on).toHaveBeenCalledWith(
          '__catchup',
          expect.any(Function),
        );
        expect(mockEmitter.on).not.toHaveBeenCalledWith(
          '__system',
          expect.any(Function),
        );
        expect(mockEmitter.on).toHaveBeenCalledWith(
          '__admin',
          expect.any(Function),
        );
      },
    );
  });

  test('events handler calls projectionHandler.projectEvent with inReplay=false', () => {
    const mockProjectFn = vi.fn();
    const context = {
      projectionHandler: {
        projectEvent: vi.fn().mockReturnValue(mockProjectFn),
        projectEventForReadModel: vi.fn(() => vi.fn()),
        projectCatchupEventForReadModel: vi.fn(() => vi.fn()),
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

  test('__replay handler calls projectEventForReadModel for known read model', () => {
    const mockProjectForRM = vi.fn();
    const context = {
      projectionHandler: {
        projectEvent: vi.fn(() => vi.fn()),
        projectEventForReadModel: vi.fn().mockReturnValue(mockProjectForRM),
        projectCatchupEventForReadModel: vi.fn(() => vi.fn()),
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
        projectEventForReadModel: vi.fn(() => vi.fn()),
        projectCatchupEventForReadModel: vi.fn(() => vi.fn()),
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
        projectEventForReadModel: vi.fn().mockReturnValue(mockProjectForRM),
        projectCatchupEventForReadModel: vi.fn(() => vi.fn()),
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
        projectEventForReadModel: vi.fn().mockReturnValue(mockProjectForRM),
        projectCatchupEventForReadModel: vi.fn(() => vi.fn()),
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

  test('__admin handler dispatches to adminInstructionHandler', () => {
    const adminHandler = vi.fn();
    const context = {
      projectionHandler: {
        projectEvent: vi.fn(() => vi.fn()),
        projectEventForReadModel: vi.fn(() => vi.fn()),
        projectCatchupEventForReadModel: vi.fn(() => vi.fn()),
      },
      adminInstructionHandler: adminHandler,
      readModels: { items: {} },
    };

    return readModelEventBusMqEmitter({ mqName: 'test-mq' })(context).then(
      () => {
        const instruction = {
          type: 'stop',
          targetReadModel: 'items',
        };
        const cb = vi.fn();
        mockHandlers['__admin'](
          {
            payload: { correlationId: 'corr-1', instruction },
          },
          cb,
        );

        expect(adminHandler).toHaveBeenCalledWith('corr-1', instruction);
        expect(cb).toHaveBeenCalled();
      },
    );
  });

  test('__admin handler rejects invalid token', () => {
    const adminHandler = vi.fn();
    const context = {
      projectionHandler: {
        projectEvent: vi.fn(() => vi.fn()),
        projectEventForReadModel: vi.fn(() => vi.fn()),
        projectCatchupEventForReadModel: vi.fn(() => vi.fn()),
      },
      adminInstructionHandler: adminHandler,
      expectedAdminToken: 'valid-token',
      readModels: { items: {} },
    };

    return readModelEventBusMqEmitter({ mqName: 'test-mq' })(context).then(
      () => {
        const instruction = {
          type: 'stop',
          targetReadModel: 'items',
          token: 'wrong-token',
        };
        const cb = vi.fn();
        mockHandlers['__admin'](
          {
            payload: { correlationId: 'corr-1', instruction },
          },
          cb,
        );

        expect(adminHandler).not.toHaveBeenCalled();
        expect(cb).toHaveBeenCalled();
      },
    );
  });

  test('__admin handler accepts valid token', () => {
    const adminHandler = vi.fn();
    const context = {
      projectionHandler: {
        projectEvent: vi.fn(() => vi.fn()),
        projectEventForReadModel: vi.fn(() => vi.fn()),
        projectCatchupEventForReadModel: vi.fn(() => vi.fn()),
      },
      adminInstructionHandler: adminHandler,
      expectedAdminToken: 'valid-token',
      readModels: { items: {} },
    };

    return readModelEventBusMqEmitter({ mqName: 'test-mq' })(context).then(
      () => {
        const instruction = {
          type: 'stop',
          targetReadModel: 'items',
          token: 'valid-token',
        };
        const cb = vi.fn();
        mockHandlers['__admin'](
          {
            payload: { correlationId: 'corr-1', instruction },
          },
          cb,
        );

        expect(adminHandler).toHaveBeenCalledWith('corr-1', instruction);
        expect(cb).toHaveBeenCalled();
      },
    );
  });
});
