import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest';
import { testing, createProjectionHandler } from '../projections.js';

import { getLogger } from '@lazyapps/logger';

const {
  collectProjections,
  logProjections,
  updateInternalReadModelTimestamps,
  updateTimestamp,
  handleProjections,
} = testing;

vi.mock('@lazyapps/logger', () => {
  const getLogger = vi.fn().mockReturnValue({
    debug: vi.fn(),
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

describe('collectProjections', () => {
  beforeEach(() => {
    getLogger();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test('find two', () => {
    const readModels = {
      rm1: {
        projections: {
          event1: () => 'projection result 1',
          event2: () => 'projection result 2',
        },
      },
      rm2: {
        projections: {
          event1: () => 'projection result 3',
          event2: () => 'projection result 4',
        },
      },
    };
    return collectProjections(readModels, {
      type: 'event1',
      timestamp: 4,
    }).then((projections) => {
      expect(projections).toBeDefined();
      expect(projections).toStrictEqual([
        ['rm1', readModels.rm1.projections.event1],
        ['rm2', readModels.rm2.projections.event1],
      ]);
    });
  });

  test('find none', () => {
    const readModels = {
      rm1: {
        projections: {
          event1: () => 'projection result 1',
          event2: () => 'projection result 2',
        },
      },
      rm2: {
        projections: {
          event1: () => 'projection result 3',
          event2: () => 'projection result 4',
        },
      },
    };
    return collectProjections(readModels, {
      type: 'event3',
      timestamp: 4,
    }).then((projections) => {
      expect(projections).toBeDefined();
      expect(projections).toStrictEqual([]);
    });
  });

  test('ignore read model without projections', () => {
    const readModels = {
      rm1: {
        projections: {
          event1: () => 'projection result 1',
          event2: () => 'projection result 2',
        },
      },
      rm2: {},
    };
    return collectProjections(readModels, {
      type: 'event1',
      timestamp: 4,
    }).then((projections) => {
      expect(projections).toBeDefined();
      expect(projections).toStrictEqual([
        ['rm1', readModels.rm1.projections.event1],
      ]);
    });
  });
});

describe('logProjections', () => {
  let log;

  beforeEach(() => {
    log = getLogger();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test('empty list', () => {
    const projs = [];
    expect(logProjections(log, false)(projs)).toBe(projs);
    expect(log.debug).toHaveBeenCalledTimes(0);
  });

  test('inReplay false', () => {
    const projs = [['rm1'], ['rm2']];
    expect(logProjections(log, false)(projs)).toBe(projs);
    expect(log.debug).toHaveBeenCalledWith(
      'Projecting event for read models: ["rm1","rm2"] (inReplay=false)',
    );
  });

  test('inReplay true', () => {
    const projs = [['rm1'], ['rm2']];
    expect(logProjections(log, true)(projs)).toBe(projs);
    expect(log.debug).toHaveBeenCalledWith(
      'Projecting event for read models: ["rm1","rm2"] (inReplay=true)',
    );
  });
});

describe('updateInternalReadModelTimestamps', () => {
  test('update', () => {
    const event = { type: 'event1', timestamp: 5 };
    const readModels = {
      rm1: { lastProjectedEventTimestamp: 3 },
      rm2: { lastProjectedEventTimestamp: 13 },
      rm3: { lastProjectedEventTimestamp: 99 },
    };

    const projections = [['rm1'], ['rm2']];
    return updateInternalReadModelTimestamps(
      event,
      readModels,
    )(projections).then((projs) => {
      expect(projs).toBe(projections);
      expect(readModels.rm1.lastProjectedEventTimestamp).toEqual(5);
      // this value has been changed downwards
      // that's the implementation - probably
      // shouldn't normally happen, but let's
      // document it for now
      expect(readModels.rm2.lastProjectedEventTimestamp).toEqual(5);
      // this one is untouched
      expect(readModels.rm3.lastProjectedEventTimestamp).toEqual(99);
    });
  });
});

describe('updateTimestamp', () => {
  test('update', () => {
    const storage = {
      updateLastProjectedEventTimestamps: vi.fn().mockResolvedValue(),
    };
    return updateTimestamp('correlation', storage, 'rm1', 99).then(() => {
      // any result we receive is irrelevant and depends on what the
      // read model projection does
      expect(storage.updateLastProjectedEventTimestamps).toHaveBeenCalledWith(
        'correlation',
        ['rm1'],
        99,
      );
    });
  });
});

describe('handleProjections', () => {
  let log;

  beforeEach(() => {
    log = getLogger();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const projContext = {};
  const getProjectionContext = () => () => vi.fn().mockReturnValue(projContext);
  const context = {
    storage: {
      updateLastProjectedEventTimestamps: vi.fn().mockResolvedValue(),
    },
  };
  const event = { timestamp: 10 };

  test('all good', () => {
    const f1 = vi.fn().mockResolvedValue();
    const f2 = vi.fn().mockResolvedValue();
    const projections = [
      ['rm1', f1],
      ['rm2', f2],
    ];
    return handleProjections(
      'correlation',
      log,
      context,
      getProjectionContext,
      false,
      event,
    )(projections).then((res) => {
      expect(res).toSatisfy((r) => Array.isArray(r));
      expect(res.length).toBe(2);
      // the results themselves have no meanings

      expect(f1).toHaveBeenCalledOnce();
      expect(f2).toHaveBeenCalledOnce();

      expect(log.error).toHaveBeenCalledTimes(0);
    });
  });

  test('one good, one error', () => {
    const f1 = vi.fn().mockRejectedValue();
    const f2 = vi.fn().mockResolvedValue();
    const projections = [
      ['rm1', f1],
      ['rm2', f2],
    ];
    return handleProjections(
      'correlation',
      log,
      context,
      getProjectionContext,
      false,
      event,
    )(projections).then((res) => {
      expect(res).toSatisfy((r) => Array.isArray(r));
      expect(res.length).toBe(2);
      // the results themselves have no meanings

      expect(f1).toHaveBeenCalledOnce();
      expect(f2).toHaveBeenCalledOnce();

      expect(log.error).toHaveBeenCalledTimes(1);
    });
  });
});

describe('collectProjections with isSkipped predicate', () => {
  test('skips read models where isSkipped returns true', () => {
    const fn1 = () => 'result 1';
    const fn2 = () => 'result 2';
    const readModels = {
      rm1: { projections: { event1: fn1 } },
      rm2: { projections: { event1: fn2 } },
    };
    const isSkipped = (rmName) => rmName === 'rm1';

    return collectProjections(readModels, { type: 'event1' }, isSkipped).then(
      (projections) => {
        expect(projections).toHaveLength(1);
        expect(projections[0][0]).toBe('rm2');
        expect(projections[0][1]).toBe(fn2);
      },
    );
  });

  test('does not skip when isSkipped returns false for all', () => {
    const fn1 = () => 'result 1';
    const fn2 = () => 'result 2';
    const readModels = {
      rm1: { projections: { event1: fn1 } },
      rm2: { projections: { event1: fn2 } },
    };
    const isSkipped = () => false;

    return collectProjections(readModels, { type: 'event1' }, isSkipped).then(
      (projections) => {
        expect(projections).toHaveLength(2);
      },
    );
  });

  test('works with undefined isSkipped (backward compatible)', () => {
    const fn1 = () => 'result 1';
    const readModels = {
      rm1: { projections: { event1: fn1 } },
    };

    return collectProjections(readModels, { type: 'event1' }, undefined).then(
      (projections) => {
        expect(projections).toHaveLength(1);
      },
    );
  });
});

describe('createProjectionHandler', () => {
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

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('replay state management', () => {
    test('setReadModelReplayState and isReadModelReplaying', () => {
      const handler = createProjectionHandler(makeContext());

      expect(handler.isReadModelReplaying('items')).toBe(false);
      handler.setReadModelReplayState('items', true);
      expect(handler.isReadModelReplaying('items')).toBe(true);
    });

    test('clearReadModelReplayState removes the state', () => {
      const handler = createProjectionHandler(makeContext());

      handler.setReadModelReplayState('items', true);
      expect(handler.isReadModelReplaying('items')).toBe(true);
      handler.clearReadModelReplayState('items');
      expect(handler.isReadModelReplaying('items')).toBe(false);
    });

    test('getReadModelReplayStates returns copy of all states', () => {
      const handler = createProjectionHandler(makeContext());

      handler.setReadModelReplayState('items', true);
      handler.setReadModelReplayState('orders', true);

      const states = handler.getReadModelReplayStates();
      expect(states).toEqual({ items: true, orders: true });

      // Verify it is a copy
      states.items = false;
      expect(handler.isReadModelReplaying('items')).toBe(true);
    });

    test('isReadModelReplaying returns false for unknown read model', () => {
      const handler = createProjectionHandler(makeContext());
      expect(handler.isReadModelReplaying('nonexistent')).toBe(false);
    });
  });

  describe('terminal state management', () => {
    test('getReadModelTerminalStatus returns null by default', () => {
      const handler = createProjectionHandler(makeContext());
      expect(handler.getReadModelTerminalStatus('items')).toBe(null);
    });

    test('setReadModelTerminalStatus and getReadModelTerminalStatus', () => {
      const handler = createProjectionHandler(makeContext());

      handler.setReadModelTerminalStatus('items', 'completed');
      expect(handler.getReadModelTerminalStatus('items')).toBe('completed');
    });

    test('setReadModelTerminalStatus with cancelled', () => {
      const handler = createProjectionHandler(makeContext());

      handler.setReadModelTerminalStatus('items', 'cancelled');
      expect(handler.getReadModelTerminalStatus('items')).toBe('cancelled');
    });

    test('setReadModelReplayState clears terminal status', () => {
      const handler = createProjectionHandler(makeContext());

      handler.setReadModelTerminalStatus('items', 'completed');
      expect(handler.getReadModelTerminalStatus('items')).toBe('completed');

      handler.setReadModelReplayState('items', true);
      expect(handler.getReadModelTerminalStatus('items')).toBe(null);
    });

    test('terminal status persists after clearReadModelReplayState', () => {
      const handler = createProjectionHandler(makeContext());

      handler.setReadModelReplayState('items', true);
      handler.clearReadModelReplayState('items');
      handler.setReadModelTerminalStatus('items', 'completed');

      expect(handler.isReadModelReplaying('items')).toBe(false);
      expect(handler.getReadModelTerminalStatus('items')).toBe('completed');
    });
  });

  describe('projectEventForReadModel', () => {
    test('projects event for the targeted read model only', () => {
      const context = makeContext();
      const handler = createProjectionHandler(context);
      const event = { type: 'ITEM_CREATED', timestamp: 100 };

      return handler
        .projectEventForReadModel(
          'corr-1',
          'items',
        )(event)
        .then(() => {
          expect(
            context.readModels.items.projections.ITEM_CREATED,
          ).toHaveBeenCalledWith(expect.any(Object), event);
          expect(
            context.readModels.orders.projections.ORDER_CREATED,
          ).not.toHaveBeenCalled();
        });
    });

    test('returns resolved promise for unknown read model', () => {
      const context = makeContext();
      const handler = createProjectionHandler(context);
      const event = { type: 'ITEM_CREATED', timestamp: 100 };

      return handler
        .projectEventForReadModel(
          'corr-1',
          'nonexistent',
        )(event)
        .then((result) => {
          expect(result).toBeUndefined();
        });
    });

    test('returns resolved promise when no matching projection', () => {
      const context = makeContext();
      const handler = createProjectionHandler(context);
      const event = { type: 'UNKNOWN_EVENT', timestamp: 100 };

      return handler
        .projectEventForReadModel(
          'corr-1',
          'items',
        )(event)
        .then((result) => {
          expect(result).toBeUndefined();
        });
    });

    test('passes inReplay=true to projection context', () => {
      const context = makeContext();
      const handler = createProjectionHandler(context);
      const event = { type: 'ITEM_CREATED', timestamp: 100 };

      return handler
        .projectEventForReadModel(
          'corr-1',
          'items',
        )(event)
        .then(() => {
          const projectionContext =
            context.readModels.items.projections.ITEM_CREATED.mock.calls[0][0];
          // inReplay=true means commands should be no-op
          return projectionContext.commands
            .execute({})()
            .then((result) => {
              expect(result).toBeUndefined();
            });
        });
    });

    test('does not update in-memory timestamp or persist to storage during replay', () => {
      const context = makeContext();
      const handler = createProjectionHandler(context);
      const event = { type: 'ITEM_CREATED', timestamp: 12345 };

      // Set a known initial timestamp
      context.readModels.items.lastProjectedEventTimestamp = 9999;

      return handler
        .projectEventForReadModel(
          'corr-1',
          'items',
        )(event)
        .then(() => {
          // In-memory timestamp must NOT be updated during replay
          expect(context.readModels.items.lastProjectedEventTimestamp).toBe(
            9999,
          );
          // Storage persistence must NOT happen per-event during replay
          expect(
            context.storage.updateLastProjectedEventTimestamps,
          ).not.toHaveBeenCalled();
        });
    });

    test('replay projection should NOT advance timestamp per-event', () => {
      const context = makeContext();
      const handler = createProjectionHandler(context);

      // Set initial timestamp to simulate pre-replay state
      context.readModels.items.lastProjectedEventTimestamp = 5000;

      const event1 = { type: 'ITEM_CREATED', timestamp: 100 };
      const event2 = { type: 'ITEM_CREATED', timestamp: 200 };

      return handler
        .projectEventForReadModel(
          'corr-1',
          'items',
        )(event1)
        .then(() => handler.projectEventForReadModel('corr-1', 'items')(event2))
        .then(() => {
          // BUG: per-event timestamp advance during replay is unsafe.
          // The in-memory timestamp should NOT be mutated during replay
          // because if replay is cancelled, we'd have an incorrect
          // timestamp that doesn't match the actual projected state.
          expect(context.readModels.items.lastProjectedEventTimestamp).toBe(
            5000,
          );
          // Storage should NOT be called per-event during replay either.
          // The timestamp should only be updated once at replay completion.
          expect(
            context.storage.updateLastProjectedEventTimestamps,
          ).not.toHaveBeenCalled();
        });
    });

    test('rethrows errors from projection', () => {
      const context = makeContext();
      const error = new Error('projection failed');
      context.readModels.items.projections.ITEM_CREATED.mockRejectedValue(
        error,
      );
      const handler = createProjectionHandler(context);
      const event = { type: 'ITEM_CREATED', timestamp: 100 };

      return handler
        .projectEventForReadModel(
          'corr-1',
          'items',
        )(event)
        .then(
          () => {
            throw new Error('should not reach here');
          },
          (err) => {
            expect(err).toBe(error);
          },
        );
    });
  });

  describe('getProjectionContext replay behavior', () => {
    test('provides no-op commands when inReplay=true', () => {
      const context = makeContext();
      const handler = createProjectionHandler(context);
      const event = { type: 'ITEM_CREATED', timestamp: 100 };

      return handler
        .projectEventForReadModel(
          'corr-1',
          'items',
        )(event)
        .then(() => {
          const projectionContext =
            context.readModels.items.projections.ITEM_CREATED.mock.calls[0][0];
          const lazyFn = projectionContext.commands.execute({
            command: 'CREATE',
          });
          expect(typeof lazyFn).toBe('function');
          return lazyFn().then((result) => {
            expect(result).toBeUndefined();
            // Real commands should NOT have been called
            expect(context.commands).not.toHaveBeenCalled();
          });
        });
    });

    test('provides no-op sendChangeNotification when inReplay=true', () => {
      const context = makeContext();
      const handler = createProjectionHandler(context);
      const event = { type: 'ITEM_CREATED', timestamp: 100 };

      return handler
        .projectEventForReadModel(
          'corr-1',
          'items',
        )(event)
        .then(() => {
          const projectionContext =
            context.readModels.items.projections.ITEM_CREATED.mock.calls[0][0];
          return projectionContext.changeNotification
            .sendChangeNotification({ readModelName: 'items' })
            .then((result) => {
              expect(result).toBeUndefined();
            });
        });
    });

    test('preserves createChangeInfo when inReplay=true', () => {
      const context = makeContext();
      const mockCreateChangeInfo = vi.fn().mockReturnValue({ info: true });
      context.changeNotification.mockReturnValue({
        sendChangeNotification: vi.fn().mockResolvedValue(),
        createChangeInfo: mockCreateChangeInfo,
      });
      const handler = createProjectionHandler(context);
      const event = { type: 'ITEM_CREATED', timestamp: 100 };

      return handler
        .projectEventForReadModel(
          'corr-1',
          'items',
        )(event)
        .then(() => {
          const projectionContext =
            context.readModels.items.projections.ITEM_CREATED.mock.calls[0][0];
          expect(projectionContext.changeNotification.createChangeInfo).toBe(
            mockCreateChangeInfo,
          );
        });
    });

    test('provides real commands when inReplay=false via projectEvent', () => {
      const context = makeContext();
      const realCommands = { execute: vi.fn() };
      context.commands.mockReturnValue(realCommands);
      const handler = createProjectionHandler(context);
      const event = { type: 'ITEM_CREATED', timestamp: 100 };

      return handler
        .projectEvent('corr-1')(event, false)
        .then(() => {
          const projectionContext =
            context.readModels.items.projections.ITEM_CREATED.mock.calls[0][0];
          expect(projectionContext.commands).toBe(realCommands);
        });
    });

    test('provides real changeNotification when inReplay=false via projectEvent', () => {
      const context = makeContext();
      const realChangeNotification = {
        sendChangeNotification: vi.fn().mockResolvedValue(),
        createChangeInfo: vi.fn(),
      };
      context.changeNotification.mockReturnValue(realChangeNotification);
      const handler = createProjectionHandler(context);
      const event = { type: 'ITEM_CREATED', timestamp: 100 };

      return handler
        .projectEvent('corr-1')(event, false)
        .then(() => {
          const projectionContext =
            context.readModels.items.projections.ITEM_CREATED.mock.calls[0][0];
          expect(projectionContext.changeNotification).toBe(
            realChangeNotification,
          );
        });
    });
  });

  describe('projectEvent skips replaying read models', () => {
    test('skips read model that is marked as replaying', () => {
      const context = makeContext();
      context.readModels.items.projections.SHARED_EVENT = vi
        .fn()
        .mockResolvedValue();
      context.readModels.orders.projections.SHARED_EVENT = vi
        .fn()
        .mockResolvedValue();
      const handler = createProjectionHandler(context);

      handler.setReadModelReplayState('items', true);
      const event = { type: 'SHARED_EVENT', timestamp: 100 };

      return handler
        .projectEvent('corr-1')(event, false)
        .then(() => {
          expect(
            context.readModels.items.projections.SHARED_EVENT,
          ).not.toHaveBeenCalled();
          expect(
            context.readModels.orders.projections.SHARED_EVENT,
          ).toHaveBeenCalled();
        });
    });
  });

  describe('statusTracker synchronization', () => {
    test('live projection updates statusTracker.lastProjectedEventTimestamp', () => {
      const context = makeContext();
      context.statusTracker = {
        updateLastProjectedEventTimestamp: vi.fn(),
      };
      const handler = createProjectionHandler(context);
      const event = { type: 'ITEM_CREATED', timestamp: 1000 };

      return handler
        .projectEvent('corr-1')(event, false)
        .then(() => {
          expect(
            context.statusTracker.updateLastProjectedEventTimestamp,
          ).toHaveBeenCalledWith('items', 1000);
        });
    });

    test('replay projection does not update storage timestamp or statusTracker', () => {
      const context = makeContext();
      context.statusTracker = {
        updateLastProjectedEventTimestamp: vi.fn(),
        updateProgress: vi.fn(),
        getStatus: vi.fn().mockReturnValue(null),
      };
      const handler = createProjectionHandler(context);
      const event = { type: 'ITEM_CREATED', timestamp: 1000 };

      return handler
        .projectEventForReadModel(
          'corr-1',
          'items',
        )(event)
        .then(() => {
          expect(
            context.storage.updateLastProjectedEventTimestamps,
          ).not.toHaveBeenCalled();
          expect(
            context.statusTracker.updateLastProjectedEventTimestamp,
          ).not.toHaveBeenCalled();
        });
    });

    test('live projection writes timestamp to secondary storage', () => {
      const context = makeContext();
      context.secondaryTimestampStorage = {
        writeTimestamp: vi.fn().mockResolvedValue(),
      };
      const handler = createProjectionHandler(context);
      const event = { type: 'ITEM_CREATED', timestamp: 3000 };

      return handler
        .projectEvent('corr-1')(event, false)
        .then(() => {
          expect(
            context.secondaryTimestampStorage.writeTimestamp,
          ).toHaveBeenCalledWith('items', 3000);
        });
    });

    test('catch-up projection writes timestamp to secondary storage', () => {
      const context = makeContext();
      context.secondaryTimestampStorage = {
        writeTimestamp: vi.fn().mockResolvedValue(),
      };
      const handler = createProjectionHandler(context);
      const event = { type: 'ITEM_CREATED', timestamp: 3500 };

      return handler
        .projectCatchupEventForReadModel(
          'corr-1',
          'items',
        )(event)
        .then(() => {
          expect(
            context.secondaryTimestampStorage.writeTimestamp,
          ).toHaveBeenCalledWith('items', 3500);
        });
    });

    test('replay projection does NOT write to secondary storage', () => {
      const context = makeContext();
      context.secondaryTimestampStorage = {
        writeTimestamp: vi.fn().mockResolvedValue(),
      };
      const handler = createProjectionHandler(context);
      const event = { type: 'ITEM_CREATED', timestamp: 3000 };

      return handler
        .projectEventForReadModel(
          'corr-1',
          'items',
        )(event)
        .then(() => {
          expect(
            context.secondaryTimestampStorage.writeTimestamp,
          ).not.toHaveBeenCalled();
        });
    });

    test('secondary storage write failure does not break primary projection', () => {
      const context = makeContext();
      context.secondaryTimestampStorage = {
        writeTimestamp: vi.fn().mockRejectedValue(new Error('disk full')),
      };
      const handler = createProjectionHandler(context);
      const event = { type: 'ITEM_CREATED', timestamp: 4000 };

      return handler
        .projectEvent('corr-1')(event, false)
        .then(() => {
          // Primary storage should still have been called
          expect(
            context.storage.updateLastProjectedEventTimestamps,
          ).toHaveBeenCalledWith('corr-1', ['items'], 4000);
          // Secondary was called but failed — no throw
          expect(
            context.secondaryTimestampStorage.writeTimestamp,
          ).toHaveBeenCalledWith('items', 4000);
        });
    });

    test('live projection keeps statusTracker in sync with readModel object', () => {
      const context = makeContext();
      context.statusTracker = {
        updateLastProjectedEventTimestamp: vi.fn(),
      };
      const handler = createProjectionHandler(context);
      const event1 = { type: 'ITEM_CREATED', timestamp: 1000 };
      const event2 = { type: 'ITEM_CREATED', timestamp: 2000 };

      return handler
        .projectEvent('corr-1')(event1, false)
        .then(() => handler.projectEvent('corr-2')(event2, false))
        .then(() => {
          expect(context.readModels.items.lastProjectedEventTimestamp).toBe(
            2000,
          );
          expect(
            context.statusTracker.updateLastProjectedEventTimestamp,
          ).toHaveBeenCalledWith('items', 2000);
        });
    });
  });
});
