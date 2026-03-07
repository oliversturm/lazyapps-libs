import { describe, test, expect, vi, beforeEach } from 'vitest';
import { createProjectionHandler, testing } from '../projections.js';

const { collectProjections } = testing;

vi.mock('@lazyapps/logger', () => {
  const getLogger = vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  });
  return { getLogger };
});

vi.mock('@opentelemetry/api', () => ({
  context: {
    active: vi.fn(() => 'captured-context'),
    with: vi.fn((ctx, fn) => fn()),
  },
  metrics: {
    getMeter: vi.fn().mockReturnValue({
      createCounter: vi.fn().mockReturnValue({ add: vi.fn() }),
      createHistogram: vi.fn().mockReturnValue({ record: vi.fn() }),
    }),
  },
  trace: {
    getTracer: vi.fn().mockReturnValue({
      startActiveSpan: vi.fn((name, opts, fn) => {
        const span = {
          end: vi.fn(),
          recordException: vi.fn(),
          setStatus: vi.fn(),
        };
        return fn(span);
      }),
    }),
  },
  SpanStatusCode: { ERROR: 2 },
}));

vi.mock('promise-queue', () => {
  const MockQueue = vi.fn(function () {
    this._queue = [];
    this._queueLength = 0;
    this.add = vi.fn((generator) => {
      this._queueLength++;
      return Promise.resolve().then(() => {
        this._queueLength--;
        return generator();
      });
    });
    this.getQueueLength = vi.fn(() => this._queueLength);
  });
  return { default: MockQueue };
});

const makeContext = () => ({
  readModels: {
    items: {
      projections: {
        ITEM_CREATED: vi.fn().mockResolvedValue(),
      },
    },
    orders: {
      projections: {
        ORDER_CREATED: vi.fn().mockResolvedValue(),
        ITEM_CREATED: vi.fn().mockResolvedValue(),
      },
    },
  },
  storage: {
    perRequest: vi.fn().mockReturnValue({}),
    updateLastProjectedEventTimestamps: vi.fn().mockResolvedValue(),
  },
  commands: vi.fn().mockReturnValue({ execute: vi.fn() }),
  changeNotification: vi.fn().mockReturnValue({
    sendChangeNotification: vi.fn().mockResolvedValue(),
    createChangeInfo: vi.fn(),
  }),
  sideEffects: {
    getSideEffectsHandler: vi.fn().mockReturnValue({}),
  },
});

describe('collectProjections with catch-up routing', () => {
  test('queues events for catching-up read models', () => {
    const fn1 = () => 'result 1';
    const fn2 = () => 'result 2';
    const readModels = {
      rm1: { projections: { event1: fn1 } },
      rm2: { projections: { event1: fn2 } },
    };
    const isCatchingUp = (rmName) => rmName === 'rm1';
    const queued = [];
    const queueForCatchup = (rmName, event) => queued.push({ rmName, event });
    const event = { type: 'event1', timestamp: 100 };

    return collectProjections(
      readModels,
      event,
      undefined,
      isCatchingUp,
      queueForCatchup,
    ).then((projections) => {
      expect(projections).toHaveLength(1);
      expect(projections[0][0]).toBe('rm2');
      expect(queued).toHaveLength(1);
      expect(queued[0].rmName).toBe('rm1');
    });
  });

  test('projects normally for non-catching-up read models', () => {
    const fn1 = () => 'result 1';
    const fn2 = () => 'result 2';
    const readModels = {
      rm1: { projections: { event1: fn1 } },
      rm2: { projections: { event1: fn2 } },
    };
    const isCatchingUp = () => false;
    const queueForCatchup = vi.fn();

    return collectProjections(
      readModels,
      { type: 'event1' },
      undefined,
      isCatchingUp,
      queueForCatchup,
    ).then((projections) => {
      expect(projections).toHaveLength(2);
      expect(queueForCatchup).not.toHaveBeenCalled();
    });
  });

  test('backward compatible: works without isCatchingUp', () => {
    const fn1 = () => 'result 1';
    const readModels = {
      rm1: { projections: { event1: fn1 } },
    };

    return collectProjections(
      readModels,
      { type: 'event1' },
      undefined,
      undefined,
      undefined,
    ).then((projections) => {
      expect(projections).toHaveLength(1);
    });
  });
});

describe('createProjectionHandler catch-up features', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('catch-up state management', () => {
    test('setReadModelCatchingUp and isReadModelCatchingUp', () => {
      const handler = createProjectionHandler(makeContext());

      expect(handler.isReadModelCatchingUp('items')).toBe(false);
      handler.setReadModelCatchingUp('items');
      expect(handler.isReadModelCatchingUp('items')).toBe(true);
    });

    test('clearCatchupState removes catch-up state', () => {
      const handler = createProjectionHandler(makeContext());

      handler.setReadModelCatchingUp('items');
      expect(handler.isReadModelCatchingUp('items')).toBe(true);
      handler.clearCatchupState('items');
      expect(handler.isReadModelCatchingUp('items')).toBe(false);
    });

    test('getFifoQueueSize returns 0 for non-catching-up rm', () => {
      const handler = createProjectionHandler(makeContext());
      expect(handler.getFifoQueueSize('items')).toBe(0);
    });

    test('getFifoQueueSize returns queue length', () => {
      const handler = createProjectionHandler(makeContext());
      handler.setReadModelCatchingUp('items');
      handler.queueLiveEvent('items', 'c1', { type: 'A', timestamp: 1 });
      handler.queueLiveEvent('items', 'c2', { type: 'B', timestamp: 2 });
      expect(handler.getFifoQueueSize('items')).toBe(2);
    });

    test('getCatchupState returns state object', () => {
      const handler = createProjectionHandler(makeContext());
      handler.setReadModelCatchingUp('items');

      const state = handler.getCatchupState('items');
      expect(state).not.toBeNull();
      expect(state.active).toBe(true);
      expect(state.fifoQueue).toEqual([]);
      expect(state.catchupEventFingerprints).toBeInstanceOf(Set);
    });

    test('getCatchupState returns null for non-catching-up rm', () => {
      const handler = createProjectionHandler(makeContext());
      expect(handler.getCatchupState('items')).toBeNull();
    });
  });

  describe('queueLiveEvent', () => {
    test('pushes event to FIFO queue', () => {
      const handler = createProjectionHandler(makeContext());
      handler.setReadModelCatchingUp('items');

      const event = { type: 'ITEM_CREATED', timestamp: 100, aggregateId: '1' };
      handler.queueLiveEvent('items', 'c1', event);

      const state = handler.getCatchupState('items');
      expect(state.fifoQueue).toHaveLength(1);
      expect(state.fifoQueue[0]).toEqual({ correlationId: 'c1', event });
    });

    test('does nothing when no catch-up state exists', () => {
      const handler = createProjectionHandler(makeContext());
      handler.queueLiveEvent('items', 'c1', { type: 'A', timestamp: 1 });
      expect(handler.getCatchupState('items')).toBeNull();
    });
  });

  describe('recordCatchupEventFingerprint', () => {
    test('records fingerprint and updates lastCatchupTimestamp', () => {
      const handler = createProjectionHandler(makeContext());
      handler.setReadModelCatchingUp('items');

      const event = { type: 'ITEM_CREATED', timestamp: 100, aggregateId: '1' };
      handler.recordCatchupEventFingerprint('items', event);

      const state = handler.getCatchupState('items');
      expect(state.catchupEventFingerprints.has('100:ITEM_CREATED:1')).toBe(
        true,
      );
      expect(state.lastCatchupTimestamp).toBe(100);
    });
  });

  describe('projectCatchupEventForReadModel', () => {
    test('projects with inReplay=false (real commands)', () => {
      const context = makeContext();
      const realCommands = { execute: vi.fn() };
      context.commands.mockReturnValue(realCommands);
      const handler = createProjectionHandler(context);
      handler.setReadModelCatchingUp('items');

      const event = { type: 'ITEM_CREATED', timestamp: 100, aggregateId: '1' };

      return handler
        .projectCatchupEventForReadModel(
          'corr-1',
          'items',
        )(event)
        .then(() => {
          const projectionContext =
            context.readModels.items.projections.ITEM_CREATED.mock.calls[0][0];
          expect(projectionContext.commands).toBe(realCommands);
        });
    });

    test('projects with real changeNotification (inReplay=false)', () => {
      const context = makeContext();
      const realChangeNotification = {
        sendChangeNotification: vi.fn().mockResolvedValue(),
        createChangeInfo: vi.fn(),
      };
      context.changeNotification.mockReturnValue(realChangeNotification);
      const handler = createProjectionHandler(context);
      handler.setReadModelCatchingUp('items');

      const event = { type: 'ITEM_CREATED', timestamp: 100, aggregateId: '1' };

      return handler
        .projectCatchupEventForReadModel(
          'corr-1',
          'items',
        )(event)
        .then(() => {
          const projectionContext =
            context.readModels.items.projections.ITEM_CREATED.mock.calls[0][0];
          expect(projectionContext.changeNotification).toBe(
            realChangeNotification,
          );
        });
    });

    test('records fingerprint for projected event', () => {
      const context = makeContext();
      const handler = createProjectionHandler(context);
      handler.setReadModelCatchingUp('items');

      const event = { type: 'ITEM_CREATED', timestamp: 100, aggregateId: '1' };

      return handler
        .projectCatchupEventForReadModel(
          'corr-1',
          'items',
        )(event)
        .then(() => {
          const state = handler.getCatchupState('items');
          expect(state.catchupEventFingerprints.has('100:ITEM_CREATED:1')).toBe(
            true,
          );
          expect(state.lastCatchupTimestamp).toBe(100);
        });
    });

    test('resolves for unknown read model', () => {
      const context = makeContext();
      const handler = createProjectionHandler(context);

      return handler
        .projectCatchupEventForReadModel(
          'corr-1',
          'nonexistent',
        )({
          type: 'A',
          timestamp: 100,
          aggregateId: '1',
        })
        .then((result) => {
          expect(result).toBeUndefined();
        });
    });

    test('resolves for non-matching projection', () => {
      const context = makeContext();
      const handler = createProjectionHandler(context);

      return handler
        .projectCatchupEventForReadModel(
          'corr-1',
          'items',
        )({
          type: 'UNKNOWN_EVENT',
          timestamp: 100,
          aggregateId: '1',
        })
        .then((result) => {
          expect(result).toBeUndefined();
        });
    });

    test('updates timestamp after successful projection', () => {
      const context = makeContext();
      const handler = createProjectionHandler(context);
      handler.setReadModelCatchingUp('items');

      const event = {
        type: 'ITEM_CREATED',
        timestamp: 12345,
        aggregateId: '1',
      };

      return handler
        .projectCatchupEventForReadModel(
          'corr-1',
          'items',
        )(event)
        .then(() => {
          expect(
            context.storage.updateLastProjectedEventTimestamps,
          ).toHaveBeenCalledWith('corr-1', ['items'], 12345);
        });
    });
  });

  describe('projectEvent routes catching-up RMs to FIFO', () => {
    test('queues event for catching-up RM and projects for live RM', () => {
      const context = makeContext();
      context.readModels.items.projections.SHARED_EVENT = vi
        .fn()
        .mockResolvedValue();
      context.readModels.orders.projections.SHARED_EVENT = vi
        .fn()
        .mockResolvedValue();
      const handler = createProjectionHandler(context);

      handler.setReadModelCatchingUp('items');
      const event = { type: 'SHARED_EVENT', timestamp: 100, aggregateId: '1' };

      return handler
        .projectEvent('corr-1')(event, false)
        .then(() => {
          expect(
            context.readModels.items.projections.SHARED_EVENT,
          ).not.toHaveBeenCalled();
          expect(
            context.readModels.orders.projections.SHARED_EVENT,
          ).toHaveBeenCalled();

          const state = handler.getCatchupState('items');
          expect(state.fifoQueue).toHaveLength(1);
          expect(state.fifoQueue[0].event).toBe(event);
          expect(state.fifoQueue[0].correlationId).toBe('corr-1');
        });
    });
  });
});
