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
  },
  ...overrides,
});

describe('lifecycleManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  describe('initialize', () => {
    test('sets all read models to waiting', () => {
      const context = createMockContext();
      const lm = createLifecycleManager(context);

      lm.initialize(['customers', 'orders']);

      expect(lm.getState('customers')).toBe('waiting');
      expect(lm.getState('orders')).toBe('waiting');
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
  });

  describe('activate', () => {
    test('transitions waiting -> activating -> catching-up', () => {
      const context = createMockContext();
      const lm = createLifecycleManager(context);
      lm.initialize(['customers']);

      return lm.activate('customers').then(() => {
        expect(context.connectEventBus).toHaveBeenCalledOnce();
        expect(
          context.projectionHandler.setReadModelCatchingUp,
        ).toHaveBeenCalledWith('customers');
        expect(lm.getState('customers')).toBe('catching-up');
      });
    });

    test('connects event bus only once across multiple activations', () => {
      const context = createMockContext();
      const lm = createLifecycleManager(context);
      lm.initialize(['customers', 'orders']);

      return lm
        .activate('customers')
        .then(() => {
          lm.setState('orders', 'waiting');
          return lm.activate('orders');
        })
        .then(() => {
          expect(context.connectEventBus).toHaveBeenCalledOnce();
        });
    });

    test('reverts to waiting when event bus connection fails', () => {
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
          expect(lm.getState('customers')).toBe('waiting');
          expect(
            context.projectionHandler.clearCatchupState,
          ).toHaveBeenCalledWith('customers');
        },
      );
    });

    test('rejects activation from catching-up state', () => {
      const context = createMockContext();
      const lm = createLifecycleManager(context);
      lm.initialize(['customers']);
      lm.setState('customers', 'catching-up');

      return lm.activate('customers').then(
        () => {
          throw new Error('should not resolve');
        },
        (err) => {
          expect(err.message).toContain('Cannot activate');
          expect(err.message).toContain('catching-up');
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

    test('rejects activation from activating state', () => {
      const context = createMockContext();
      const lm = createLifecycleManager(context);
      lm.initialize(['customers']);
      lm.setState('customers', 'activating');

      return lm.activate('customers').then(
        () => {
          throw new Error('should not resolve');
        },
        (err) => {
          expect(err.message).toContain('Cannot activate');
          expect(err.message).toContain('activating');
        },
      );
    });

    test('allows activation from stopped state', () => {
      const context = createMockContext();
      const lm = createLifecycleManager(context);
      lm.initialize(['customers']);
      lm.setState('customers', 'stopped');

      return lm.activate('customers').then(() => {
        expect(lm.getState('customers')).toBe('catching-up');
      });
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
        expect(lm.getState('customers')).toBe('catching-up');
        expect(lm.getState('orders')).toBe('catching-up');
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
            expect(lm.getState('customers')).toBe('waiting');
            return lm.activate('customers');
          },
        )
        .then(() => {
          expect(connectEventBus).toHaveBeenCalledTimes(2);
          expect(lm.getState('customers')).toBe('catching-up');
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
  });
});
