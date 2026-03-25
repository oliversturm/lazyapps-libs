import { describe, test, expect, vi, beforeEach } from 'vitest';
import { createProjectionHandler } from '../projections.js';

vi.mock('@lazyapps/logger', () => {
  const getLogger = vi.fn().mockReturnValue({
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
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

const makeContext = () => {
  const executeResult = vi.fn().mockResolvedValue('cmd-result');
  const realExecute = vi.fn().mockReturnValue(executeResult);
  const realSchedule = vi.fn().mockResolvedValue('schedule-result');

  return {
    readModels: {
      items: {
        projections: {
          ITEM_CREATED: vi.fn().mockResolvedValue(),
        },
      },
    },
    storage: {
      perRequest: vi.fn().mockReturnValue({}),
      updateLastProjectedEventTimestamps: vi.fn().mockResolvedValue(),
    },
    commands: vi.fn().mockReturnValue({
      execute: realExecute,
    }),
    changeNotification: vi.fn().mockReturnValue({
      sendChangeNotification: vi.fn().mockResolvedValue(),
      createChangeInfo: vi.fn(),
    }),
    sideEffects: {
      getSideEffectsHandler: vi.fn().mockReturnValue({
        schedule: realSchedule,
      }),
    },
    __mocks: { realExecute, executeResult, realSchedule },
  };
};

describe('side-effect filter in projections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('setSideEffectFilter / getSideEffectFilter / clearSideEffectFilter', () => {
    test('stores and retrieves a filter', () => {
      const handler = createProjectionHandler(makeContext());
      const filter = {
        byName: { type: 'include', names: ['sendEmail'] },
      };

      handler.setSideEffectFilter('items', filter);
      expect(handler.getSideEffectFilter('items')).toBe(filter);
    });

    test('returns null for unset filter', () => {
      const handler = createProjectionHandler(makeContext());
      expect(handler.getSideEffectFilter('items')).toBeNull();
    });

    test('clears a stored filter', () => {
      const handler = createProjectionHandler(makeContext());
      const filter = {
        byName: { type: 'include', names: ['sendEmail'] },
      };

      handler.setSideEffectFilter('items', filter);
      handler.clearSideEffectFilter('items');
      expect(handler.getSideEffectFilter('items')).toBeNull();
    });
  });

  describe('ByName filter on sideEffects during replay', () => {
    test('IncludeByName allows matching side-effect to run', () => {
      const context = makeContext();
      const handler = createProjectionHandler(context);

      handler.setSideEffectFilter('items', {
        byName: { type: 'include', names: ['sendEmail'] },
      });

      const event = { type: 'ITEM_CREATED', timestamp: 100 };

      return handler
        .projectEventForReadModel(
          'corr-1',
          'items',
        )(event)
        .then(() => {
          const projCtx =
            context.readModels.items.projections.ITEM_CREATED.mock.calls[0][0];
          // With filter, getSideEffectsHandler is called with
          // inReplay=false (filter takes over)
          expect(
            context.sideEffects.getSideEffectsHandler,
          ).toHaveBeenCalledWith('corr-1', false);
          // The schedule function is a wrapper, call it
          const generator = () => Promise.resolve();
          return projCtx.sideEffects
            .schedule(generator, { name: 'sendEmail' })
            .then(() => {
              // Real schedule should have been called
              expect(context.__mocks.realSchedule).toHaveBeenCalledWith(
                generator,
                { name: 'sendEmail' },
              );
            });
        });
    });

    test('IncludeByName filters out non-matching side-effect', () => {
      const context = makeContext();
      const handler = createProjectionHandler(context);

      handler.setSideEffectFilter('items', {
        byName: { type: 'include', names: ['sendEmail'] },
      });

      const event = { type: 'ITEM_CREATED', timestamp: 100 };

      return handler
        .projectEventForReadModel(
          'corr-1',
          'items',
        )(event)
        .then(() => {
          const projCtx =
            context.readModels.items.projections.ITEM_CREATED.mock.calls[0][0];
          const generator = () => Promise.resolve();
          return projCtx.sideEffects
            .schedule(generator, { name: 'sendWebhook' })
            .then(() => {
              // Real schedule should NOT have been called
              expect(context.__mocks.realSchedule).not.toHaveBeenCalled();
            });
        });
    });

    test('ExcludeByName allows non-matching side-effect to run', () => {
      const context = makeContext();
      const handler = createProjectionHandler(context);

      handler.setSideEffectFilter('items', {
        byName: { type: 'exclude', names: ['sendWebhook'] },
      });

      const event = { type: 'ITEM_CREATED', timestamp: 100 };

      return handler
        .projectEventForReadModel(
          'corr-1',
          'items',
        )(event)
        .then(() => {
          const projCtx =
            context.readModels.items.projections.ITEM_CREATED.mock.calls[0][0];
          const generator = () => Promise.resolve();
          return projCtx.sideEffects
            .schedule(generator, { name: 'sendEmail' })
            .then(() => {
              expect(context.__mocks.realSchedule).toHaveBeenCalled();
            });
        });
    });

    test('ExcludeByName filters out matching side-effect', () => {
      const context = makeContext();
      const handler = createProjectionHandler(context);

      handler.setSideEffectFilter('items', {
        byName: { type: 'exclude', names: ['sendWebhook'] },
      });

      const event = { type: 'ITEM_CREATED', timestamp: 100 };

      return handler
        .projectEventForReadModel(
          'corr-1',
          'items',
        )(event)
        .then(() => {
          const projCtx =
            context.readModels.items.projections.ITEM_CREATED.mock.calls[0][0];
          const generator = () => Promise.resolve();
          return projCtx.sideEffects
            .schedule(generator, { name: 'sendWebhook' })
            .then(() => {
              expect(context.__mocks.realSchedule).not.toHaveBeenCalled();
            });
        });
    });

    test('unnamed side-effect uses "unnamed" for filter matching', () => {
      const context = makeContext();
      const handler = createProjectionHandler(context);

      handler.setSideEffectFilter('items', {
        byName: { type: 'include', names: ['unnamed'] },
      });

      const event = { type: 'ITEM_CREATED', timestamp: 100 };

      return handler
        .projectEventForReadModel(
          'corr-1',
          'items',
        )(event)
        .then(() => {
          const projCtx =
            context.readModels.items.projections.ITEM_CREATED.mock.calls[0][0];
          const generator = () => Promise.resolve();
          // No name option — defaults to 'unnamed'
          return projCtx.sideEffects.schedule(generator).then(() => {
            expect(context.__mocks.realSchedule).toHaveBeenCalled();
          });
        });
    });
  });

  describe('ByCommand filter on commands during replay', () => {
    test('IncludeCommand allows matching command to execute', () => {
      const context = makeContext();
      const handler = createProjectionHandler(context);

      handler.setSideEffectFilter('items', {
        byCommand: {
          type: 'include',
          commands: ['CREATE_ORDER'],
        },
      });

      const event = { type: 'ITEM_CREATED', timestamp: 100 };

      return handler
        .projectEventForReadModel(
          'corr-1',
          'items',
        )(event)
        .then(() => {
          const projCtx =
            context.readModels.items.projections.ITEM_CREATED.mock.calls[0][0];
          // Commands should be wrapped, not stubbed
          const cmdThunk = projCtx.commands.execute({
            type: 'CREATE_ORDER',
          });
          // Real execute should have been called
          expect(context.__mocks.realExecute).toHaveBeenCalledWith({
            type: 'CREATE_ORDER',
          });
          // The thunk should be the real result
          expect(cmdThunk).toBe(context.__mocks.executeResult);
        });
    });

    test('IncludeCommand stubs non-matching command', () => {
      const context = makeContext();
      const handler = createProjectionHandler(context);

      handler.setSideEffectFilter('items', {
        byCommand: {
          type: 'include',
          commands: ['CREATE_ORDER'],
        },
      });

      const event = { type: 'ITEM_CREATED', timestamp: 100 };

      return handler
        .projectEventForReadModel(
          'corr-1',
          'items',
        )(event)
        .then(() => {
          const projCtx =
            context.readModels.items.projections.ITEM_CREATED.mock.calls[0][0];
          const cmdThunk = projCtx.commands.execute({
            type: 'DELETE_USER',
          });
          // Real execute should NOT have been called
          expect(context.__mocks.realExecute).not.toHaveBeenCalled();
          // The thunk should be a no-op
          return cmdThunk().then((result) => {
            expect(result).toBeUndefined();
          });
        });
    });

    test('ExcludeCommand stubs matching command', () => {
      const context = makeContext();
      const handler = createProjectionHandler(context);

      handler.setSideEffectFilter('items', {
        byCommand: {
          type: 'exclude',
          commands: ['DELETE_USER'],
        },
      });

      const event = { type: 'ITEM_CREATED', timestamp: 100 };

      return handler
        .projectEventForReadModel(
          'corr-1',
          'items',
        )(event)
        .then(() => {
          const projCtx =
            context.readModels.items.projections.ITEM_CREATED.mock.calls[0][0];
          const cmdThunk = projCtx.commands.execute({
            type: 'DELETE_USER',
          });
          expect(context.__mocks.realExecute).not.toHaveBeenCalled();
          return cmdThunk().then((result) => {
            expect(result).toBeUndefined();
          });
        });
    });

    test('ExcludeCommand allows non-matching command', () => {
      const context = makeContext();
      const handler = createProjectionHandler(context);

      handler.setSideEffectFilter('items', {
        byCommand: {
          type: 'exclude',
          commands: ['DELETE_USER'],
        },
      });

      const event = { type: 'ITEM_CREATED', timestamp: 100 };

      return handler
        .projectEventForReadModel(
          'corr-1',
          'items',
        )(event)
        .then(() => {
          const projCtx =
            context.readModels.items.projections.ITEM_CREATED.mock.calls[0][0];
          projCtx.commands.execute({ type: 'CREATE_ORDER' });
          expect(context.__mocks.realExecute).toHaveBeenCalledWith({
            type: 'CREATE_ORDER',
          });
        });
    });
  });

  describe('combined ByName + ByCommand filter', () => {
    test('applies both filters simultaneously', () => {
      const context = makeContext();
      const handler = createProjectionHandler(context);

      handler.setSideEffectFilter('items', {
        byName: { type: 'include', names: ['sendEmail'] },
        byCommand: {
          type: 'exclude',
          commands: ['DELETE_USER'],
        },
      });

      const event = { type: 'ITEM_CREATED', timestamp: 100 };

      return handler
        .projectEventForReadModel(
          'corr-1',
          'items',
        )(event)
        .then(() => {
          const projCtx =
            context.readModels.items.projections.ITEM_CREATED.mock.calls[0][0];

          // Side-effect: sendEmail included
          const gen = () => Promise.resolve();
          return projCtx.sideEffects
            .schedule(gen, { name: 'sendEmail' })
            .then(() => {
              expect(context.__mocks.realSchedule).toHaveBeenCalled();
              context.__mocks.realSchedule.mockClear();

              // Side-effect: sendWebhook excluded
              return projCtx.sideEffects.schedule(gen, {
                name: 'sendWebhook',
              });
            })
            .then(() => {
              expect(context.__mocks.realSchedule).not.toHaveBeenCalled();

              // Command: CREATE_ORDER allowed
              projCtx.commands.execute({ type: 'CREATE_ORDER' });
              expect(context.__mocks.realExecute).toHaveBeenCalled();
              context.__mocks.realExecute.mockClear();

              // Command: DELETE_USER excluded
              projCtx.commands.execute({ type: 'DELETE_USER' });
              expect(context.__mocks.realExecute).not.toHaveBeenCalled();
            });
        });
    });
  });

  describe('no filter (default behavior)', () => {
    test('replay without filter stubs commands entirely', () => {
      const context = makeContext();
      const handler = createProjectionHandler(context);
      // No filter set

      const event = { type: 'ITEM_CREATED', timestamp: 100 };

      return handler
        .projectEventForReadModel(
          'corr-1',
          'items',
        )(event)
        .then(() => {
          const projCtx =
            context.readModels.items.projections.ITEM_CREATED.mock.calls[0][0];
          // Commands should be fully stubbed (no-op)
          return projCtx.commands
            .execute({ type: 'CREATE_ORDER' })()
            .then((result) => {
              expect(result).toBeUndefined();
              // Real execute should NOT have been called
              expect(context.__mocks.realExecute).not.toHaveBeenCalled();
            });
        });
    });

    test('replay without filter skips side-effects via inReplay', () => {
      const context = makeContext();
      const handler = createProjectionHandler(context);
      // No filter set

      const event = { type: 'ITEM_CREATED', timestamp: 100 };

      return handler
        .projectEventForReadModel(
          'corr-1',
          'items',
        )(event)
        .then(() => {
          // getSideEffectsHandler should be called with inReplay=true
          expect(
            context.sideEffects.getSideEffectsHandler,
          ).toHaveBeenCalledWith('corr-1', true);
        });
    });
  });

  describe('enableSideEffects during replay', () => {
    test('un-stubs commands when enableSideEffects=true', () => {
      const context = makeContext();
      const handler = createProjectionHandler(context);

      handler.setReplayOptions('items', { enableSideEffects: true });

      const event = { type: 'ITEM_CREATED', timestamp: 100 };

      return handler
        .projectEventForReadModel(
          'corr-1',
          'items',
        )(event)
        .then(() => {
          const projCtx =
            context.readModels.items.projections.ITEM_CREATED.mock.calls[0][0];
          // Commands should be real, not stubbed
          projCtx.commands.execute({ type: 'CREATE_ORDER' });
          expect(context.__mocks.realExecute).toHaveBeenCalledWith({
            type: 'CREATE_ORDER',
          });
        });
    });

    test('un-stubs sideEffects when enableSideEffects=true', () => {
      const context = makeContext();
      const handler = createProjectionHandler(context);

      handler.setReplayOptions('items', { enableSideEffects: true });

      const event = { type: 'ITEM_CREATED', timestamp: 100 };

      return handler
        .projectEventForReadModel(
          'corr-1',
          'items',
        )(event)
        .then(() => {
          // getSideEffectsHandler should be called with inReplay=false
          expect(
            context.sideEffects.getSideEffectsHandler,
          ).toHaveBeenCalledWith('corr-1', false);
        });
    });
  });

  describe('suppressSideEffects during catch-up', () => {
    test('stubs commands when suppressSideEffects=true', () => {
      const context = makeContext();
      const handler = createProjectionHandler(context);

      handler.setReplayOptions('items', {
        suppressSideEffects: true,
      });
      handler.setReadModelCatchingUp('items');

      const event = { type: 'ITEM_CREATED', timestamp: 100 };

      return handler
        .projectCatchupEventForReadModel(
          'corr-1',
          'items',
        )(event)
        .then(() => {
          const projCtx =
            context.readModels.items.projections.ITEM_CREATED.mock.calls[0][0];
          // Commands should be stubbed
          return projCtx.commands
            .execute({ type: 'CREATE_ORDER' })()
            .then((result) => {
              expect(result).toBeUndefined();
              expect(context.__mocks.realExecute).not.toHaveBeenCalled();
            });
        });
    });

    test('stubs sideEffects when suppressSideEffects=true', () => {
      const context = makeContext();
      const handler = createProjectionHandler(context);

      handler.setReplayOptions('items', {
        suppressSideEffects: true,
      });
      handler.setReadModelCatchingUp('items');

      const event = { type: 'ITEM_CREATED', timestamp: 100 };

      return handler
        .projectCatchupEventForReadModel(
          'corr-1',
          'items',
        )(event)
        .then(() => {
          // getSideEffectsHandler should be called with inReplay=true
          // (which makes schedule skip)
          expect(
            context.sideEffects.getSideEffectsHandler,
          ).toHaveBeenCalledWith('corr-1', true);
        });
    });
  });

  describe('setReplayOptions / getReplayOptions / clearReplayOptions', () => {
    test('stores and retrieves full options', () => {
      const handler = createProjectionHandler(makeContext());
      const opts = {
        enableSideEffects: true,
        sideEffectFilter: {
          byName: { type: 'include', names: ['x'] },
        },
      };

      handler.setReplayOptions('items', opts);
      expect(handler.getReplayOptions('items')).toBe(opts);
    });

    test('returns null for unset options', () => {
      const handler = createProjectionHandler(makeContext());
      expect(handler.getReplayOptions('items')).toBeNull();
    });

    test('clears stored options', () => {
      const handler = createProjectionHandler(makeContext());
      handler.setReplayOptions('items', { enableSideEffects: true });
      handler.clearReplayOptions('items');
      expect(handler.getReplayOptions('items')).toBeNull();
    });
  });

  describe('filter during catch-up', () => {
    test('ByName filter applies during catch-up projection', () => {
      const context = makeContext();
      const handler = createProjectionHandler(context);

      handler.setSideEffectFilter('items', {
        byName: { type: 'include', names: ['sendEmail'] },
      });
      handler.setReadModelCatchingUp('items');

      const event = { type: 'ITEM_CREATED', timestamp: 100 };

      return handler
        .projectCatchupEventForReadModel(
          'corr-1',
          'items',
        )(event)
        .then(() => {
          const projCtx =
            context.readModels.items.projections.ITEM_CREATED.mock.calls[0][0];

          // Matching name runs
          const gen = () => Promise.resolve();
          return projCtx.sideEffects
            .schedule(gen, { name: 'sendEmail' })
            .then(() => {
              expect(context.__mocks.realSchedule).toHaveBeenCalled();
              context.__mocks.realSchedule.mockClear();

              // Non-matching name filtered
              return projCtx.sideEffects.schedule(gen, {
                name: 'sendWebhook',
              });
            })
            .then(() => {
              expect(context.__mocks.realSchedule).not.toHaveBeenCalled();
            });
        });
    });

    test('ByCommand filter applies during catch-up projection', () => {
      const context = makeContext();
      const handler = createProjectionHandler(context);

      handler.setSideEffectFilter('items', {
        byCommand: {
          type: 'exclude',
          commands: ['DELETE_USER'],
        },
      });
      handler.setReadModelCatchingUp('items');

      const event = { type: 'ITEM_CREATED', timestamp: 100 };

      return handler
        .projectCatchupEventForReadModel(
          'corr-1',
          'items',
        )(event)
        .then(() => {
          const projCtx =
            context.readModels.items.projections.ITEM_CREATED.mock.calls[0][0];

          // Allowed command
          projCtx.commands.execute({ type: 'CREATE_ORDER' });
          expect(context.__mocks.realExecute).toHaveBeenCalled();
          context.__mocks.realExecute.mockClear();

          // Excluded command
          const thunk = projCtx.commands.execute({
            type: 'DELETE_USER',
          });
          expect(context.__mocks.realExecute).not.toHaveBeenCalled();
          return thunk().then((r) => expect(r).toBeUndefined());
        });
    });
  });
});
