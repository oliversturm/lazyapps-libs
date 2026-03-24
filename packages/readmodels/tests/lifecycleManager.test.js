import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { createLifecycleManager } = await import('../lifecycleManager.js');

const createMockContext = (overrides = {}) => ({
  readModels: {
    customers: { lastProjectedEventTimestamp: 500 },
    orders: { lastProjectedEventTimestamp: 0 },
  },
  correlationConfig: { serviceId: 'test-service' },
  connectEventBus: vi.fn().mockResolvedValue(),
  projectionHandler: {
    setReadModelCatchingUp: vi.fn(),
    clearCatchupState: vi.fn(),
    setReadModelReplayState: vi.fn(),
    clearReadModelReplayState: vi.fn(),
  },
  storage: {
    updateLastProjectedEventTimestamps: vi.fn().mockResolvedValue(),
  },
  statusTracker: {
    setState: vi.fn(),
    updateLastProjectedEventTimestamp: vi.fn(),
  },
  catchupHandler: {
    handleCatchupComplete: vi.fn().mockResolvedValue(),
  },
  ...overrides,
});

describe('lifecycleManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  describe('initialize', () => {
    test('sets all read models to stopped', () => {
      const context = createMockContext();
      const lm = createLifecycleManager(context);

      lm.initialize(['customers', 'orders']);

      expect(lm.getState('customers')).toBe('stopped');
      expect(lm.getState('orders')).toBe('stopped');
    });

    test('returns unknown for uninitialized read model', () => {
      const context = createMockContext();
      const lm = createLifecycleManager(context);

      expect(lm.getState('nonexistent')).toBe('unknown');
    });
  });

  describe('setState', () => {
    test('transitions state with logging', () => {
      const context = createMockContext();
      const lm = createLifecycleManager(context);

      lm.initialize(['customers']);
      lm.setState('customers', 'live');

      expect(lm.getState('customers')).toBe('live');
    });

    test('pushes status update via statusTracker', () => {
      const context = createMockContext();
      const lm = createLifecycleManager(context);

      lm.initialize(['customers']);
      lm.setState('customers', 'live', 'corr-1');

      expect(context.statusTracker.setState).toHaveBeenCalledWith(
        'customers',
        'live',
        'corr-1',
      );
    });
  });

  describe('activate', () => {
    test('transitions stopped -> catchup', () => {
      const context = createMockContext();
      const lm = createLifecycleManager(context);
      lm.initialize(['customers']);

      return lm.activate('customers').then(() => {
        expect(context.connectEventBus).toHaveBeenCalledOnce();
        expect(
          context.projectionHandler.setReadModelCatchingUp,
        ).toHaveBeenCalledWith('customers');
        expect(lm.getState('customers')).toBe('catchup');
      });
    });

    test('connects message bus only once across multiple activations', () => {
      const context = createMockContext();
      const lm = createLifecycleManager(context);
      lm.initialize(['customers', 'orders']);

      return Promise.all([
        lm.activate('customers'),
        lm.activate('orders'),
      ]).then(() => {
        expect(context.connectEventBus).toHaveBeenCalledOnce();
      });
    });

    test('reverts to stopped when message bus connection fails', () => {
      const context = createMockContext({
        connectEventBus: vi
          .fn()
          .mockRejectedValue(new Error('Connection failed')),
      });
      const lm = createLifecycleManager(context);
      lm.initialize(['customers']);

      return lm.activate('customers').then(
        () => {
          throw new Error('should not resolve');
        },
        () => {
          expect(lm.getState('customers')).toBe('stopped');
          expect(
            context.projectionHandler.clearCatchupState,
          ).toHaveBeenCalledWith('customers');
        },
      );
    });

    test('rejects activation from catchup state', () => {
      const context = createMockContext();
      const lm = createLifecycleManager(context);
      lm.initialize(['customers']);
      lm.setState('customers', 'catchup');

      return lm.activate('customers').then(
        () => {
          throw new Error('should not resolve');
        },
        (err) => {
          expect(err.message).toContain('Cannot activate');
          expect(err.message).toContain('catchup');
        },
      );
    });

    test('rejects activation from live state', () => {
      const context = createMockContext();
      const lm = createLifecycleManager(context);
      lm.initialize(['customers']);
      lm.setState('customers', 'live');

      return lm.activate('customers').then(
        () => {
          throw new Error('should not resolve');
        },
        (err) => {
          expect(err.message).toContain('Cannot activate');
          expect(err.message).toContain('live');
        },
      );
    });

    test('rejects activation from replay state', () => {
      const context = createMockContext();
      const lm = createLifecycleManager(context);
      lm.initialize(['customers']);
      lm.setState('customers', 'replay');

      return lm.activate('customers').then(
        () => {
          throw new Error('should not resolve');
        },
        (err) => {
          expect(err.message).toContain('Cannot activate');
          expect(err.message).toContain('replay');
        },
      );
    });

    test('does not return fromTimestamp', () => {
      const context = createMockContext();
      const lm = createLifecycleManager(context);
      lm.initialize(['customers']);

      return lm.activate('customers').then((result) => {
        expect(result).toBeUndefined();
      });
    });

    test('concurrent activate calls share single connectEventBus call', () => {
      const context = createMockContext();
      const lm = createLifecycleManager(context);
      lm.initialize(['customers', 'orders']);

      return Promise.all([
        lm.activate('customers'),
        lm.activate('orders'),
      ]).then(() => {
        expect(context.connectEventBus).toHaveBeenCalledOnce();
        expect(lm.getState('customers')).toBe('catchup');
        expect(lm.getState('orders')).toBe('catchup');
      });
    });

    test('retries connectEventBus after failure', () => {
      const connectEventBus = vi
        .fn()
        .mockRejectedValueOnce(new Error('Connection failed'))
        .mockResolvedValueOnce();
      const context = createMockContext({ connectEventBus });
      const lm = createLifecycleManager(context);
      lm.initialize(['customers']);

      return lm
        .activate('customers')
        .then(
          () => {
            throw new Error('should not resolve');
          },
          () => {
            expect(lm.getState('customers')).toBe('stopped');
            return lm.activate('customers');
          },
        )
        .then(() => {
          expect(connectEventBus).toHaveBeenCalledTimes(2);
          expect(lm.getState('customers')).toBe('catchup');
        });
    });
  });

  describe('stop', () => {
    test('transitions to stopped', () => {
      const context = createMockContext();
      const lm = createLifecycleManager(context);
      lm.initialize(['customers']);
      lm.setState('customers', 'live');

      lm.stop('customers');

      expect(lm.getState('customers')).toBe('stopped');
    });

    test('is no-op when already stopped', () => {
      const context = createMockContext();
      const lm = createLifecycleManager(context);
      lm.initialize(['customers']);

      lm.stop('customers');

      expect(lm.getState('customers')).toBe('stopped');
    });

    test('clears catchup state when stopping from catchup', () => {
      const context = createMockContext();
      const lm = createLifecycleManager(context);
      lm.initialize(['customers']);
      lm.setState('customers', 'catchup');

      lm.stop('customers');

      expect(context.projectionHandler.clearCatchupState).toHaveBeenCalledWith(
        'customers',
      );
      expect(lm.getState('customers')).toBe('stopped');
    });
  });

  describe('startReplay', () => {
    test('transitions stopped -> replay', () => {
      const context = createMockContext();
      const lm = createLifecycleManager(context);
      lm.initialize(['customers']);

      return lm.startReplay('customers', 'corr-1').then(() => {
        expect(lm.getState('customers')).toBe('replay');
        expect(
          context.projectionHandler.setReadModelReplayState,
        ).toHaveBeenCalledWith('customers', true);
      });
    });

    test('rejects from non-stopped state', () => {
      const context = createMockContext();
      const lm = createLifecycleManager(context);
      lm.initialize(['customers']);
      lm.setState('customers', 'live');

      return lm.startReplay('customers', 'corr-1').then(
        () => {
          throw new Error('should not resolve');
        },
        (err) => {
          expect(err.message).toContain('Cannot start replay');
          expect(err.message).toContain('live');
        },
      );
    });
  });

  describe('replayDone', () => {
    test('transitions replay -> stopped and clears replay state', () => {
      const context = createMockContext();
      const lm = createLifecycleManager(context);
      lm.initialize(['customers']);
      lm.setState('customers', 'replay');

      lm.replayDone('customers', 'corr-1');

      expect(lm.getState('customers')).toBe('stopped');
      expect(
        context.projectionHandler.clearReadModelReplayState,
      ).toHaveBeenCalledWith('customers');
    });

    test('warns when not in replay state', () => {
      const context = createMockContext();
      const lm = createLifecycleManager(context);
      lm.initialize(['customers']);

      lm.replayDone('customers', 'corr-1');

      // Should not crash, state unchanged
      expect(lm.getState('customers')).toBe('stopped');
    });
  });

  describe('catchupDone', () => {
    test('drains FIFO and transitions catchup -> live', () => {
      const context = createMockContext();
      const lm = createLifecycleManager(context);
      lm.initialize(['customers']);
      lm.setState('customers', 'catchup');

      return lm.catchupDone('customers', 100, 'corr-1').then(() => {
        expect(
          context.catchupHandler.handleCatchupComplete,
        ).toHaveBeenCalledWith('customers', 100, 'corr-1');
        expect(lm.getState('customers')).toBe('live');
      });
    });

    test('resolves when not in catchup state', () => {
      const context = createMockContext();
      const lm = createLifecycleManager(context);
      lm.initialize(['customers']);

      return lm.catchupDone('customers', 100, 'corr-1').then(() => {
        expect(
          context.catchupHandler.handleCatchupComplete,
        ).not.toHaveBeenCalled();
      });
    });
  });

  describe('isValidTransition', () => {
    test('allows valid transitions', () => {
      const context = createMockContext();
      const lm = createLifecycleManager(context);

      expect(lm.isValidTransition('stopped', 'replay')).toBe(true);
      expect(lm.isValidTransition('stopped', 'catchup')).toBe(true);
      expect(lm.isValidTransition('live', 'stopped')).toBe(true);
      expect(lm.isValidTransition('replay', 'stopped')).toBe(true);
      expect(lm.isValidTransition('catchup', 'live')).toBe(true);
      expect(lm.isValidTransition('catchup', 'stopped')).toBe(true);
    });

    test('rejects invalid transitions', () => {
      const context = createMockContext();
      const lm = createLifecycleManager(context);

      expect(lm.isValidTransition('stopped', 'live')).toBe(false);
      expect(lm.isValidTransition('live', 'replay')).toBe(false);
      expect(lm.isValidTransition('replay', 'live')).toBe(false);
      expect(lm.isValidTransition('replay', 'catchup')).toBe(false);
    });
  });
});
