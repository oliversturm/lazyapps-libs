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
      const lm = createLifecycleManager(context, {
        catchupServiceUrl: 'http://admin:3005',
      });

      lm.initialize(['customers', 'orders']);

      expect(lm.getState('customers')).toBe('waiting');
      expect(lm.getState('orders')).toBe('waiting');
    });

    test('returns unknown for uninitialized read model', () => {
      const context = createMockContext();
      const lm = createLifecycleManager(context, {
        catchupServiceUrl: 'http://admin:3005',
      });

      expect(lm.getState('nonexistent')).toBe('unknown');
    });
  });

  describe('setState', () => {
    test('transitions state with logging', () => {
      const context = createMockContext();
      const lm = createLifecycleManager(context, {
        catchupServiceUrl: 'http://admin:3005',
      });

      lm.initialize(['customers']);
      lm.setState('customers', 'live');

      expect(lm.getState('customers')).toBe('live');
    });
  });

  describe('activate', () => {
    test('transitions waiting -> activating -> catching-up', () => {
      const context = createMockContext();
      const lm = createLifecycleManager(context, {
        catchupServiceUrl: 'http://admin:3005',
      });
      lm.initialize(['customers']);

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

      return lm.activate('customers').then(() => {
        expect(context.connectEventBus).toHaveBeenCalledOnce();
        expect(
          context.projectionHandler.setReadModelCatchingUp,
        ).toHaveBeenCalledWith('customers');
        expect(lm.getState('customers')).toBe('catching-up');
        expect(fetch).toHaveBeenCalledWith(
          'http://admin:3005/admin/catchup/customers/start',
          expect.objectContaining({
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              fromTimestamp: 500,
              serviceId: 'test-service',
            }),
          }),
        );
        vi.unstubAllGlobals();
      });
    });

    test('connects event bus only once across multiple activations', () => {
      const context = createMockContext();
      const lm = createLifecycleManager(context, {
        catchupServiceUrl: 'http://admin:3005',
      });
      lm.initialize(['customers', 'orders']);

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

      return lm
        .activate('customers')
        .then(() => {
          lm.setState('orders', 'waiting');
          return lm.activate('orders');
        })
        .then(() => {
          expect(context.connectEventBus).toHaveBeenCalledOnce();
          vi.unstubAllGlobals();
        });
    });

    test('reverts to waiting when CP is unavailable', () => {
      const context = createMockContext();
      const lm = createLifecycleManager(context, {
        catchupServiceUrl: 'http://admin:3005',
      });
      lm.initialize(['customers']);

      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      );

      return lm.activate('customers').then(
        () => {
          throw new Error('should not resolve');
        },
        () => {
          expect(lm.getState('customers')).toBe('waiting');
          expect(
            context.projectionHandler.clearCatchupState,
          ).toHaveBeenCalledWith('customers');
          vi.unstubAllGlobals();
        },
      );
    });

    test('reverts to waiting when CP returns non-ok response', () => {
      const context = createMockContext();
      const lm = createLifecycleManager(context, {
        catchupServiceUrl: 'http://admin:3005',
      });
      lm.initialize(['customers']);

      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
        }),
      );

      return lm.activate('customers').then(
        () => {
          throw new Error('should not resolve');
        },
        () => {
          expect(lm.getState('customers')).toBe('waiting');
          vi.unstubAllGlobals();
        },
      );
    });

    test('rejects activation from catching-up state', () => {
      const context = createMockContext();
      const lm = createLifecycleManager(context, {
        catchupServiceUrl: 'http://admin:3005',
      });
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

    test('allows activation from stopped state', () => {
      const context = createMockContext();
      const lm = createLifecycleManager(context, {
        catchupServiceUrl: 'http://admin:3005',
      });
      lm.initialize(['customers']);
      lm.setState('customers', 'stopped');

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

      return lm.activate('customers').then(() => {
        expect(lm.getState('customers')).toBe('catching-up');
        vi.unstubAllGlobals();
      });
    });
  });

  describe('stop', () => {
    test('transitions to stopped', () => {
      const context = createMockContext();
      const lm = createLifecycleManager(context, {
        catchupServiceUrl: 'http://admin:3005',
      });
      lm.initialize(['customers']);
      lm.setState('customers', 'live');

      lm.stop('customers');

      expect(lm.getState('customers')).toBe('stopped');
    });
  });

  describe('autoActivateWithRetry', () => {
    test('succeeds on first attempt', () => {
      const context = createMockContext();
      const lm = createLifecycleManager(context, {
        catchupServiceUrl: 'http://admin:3005',
      });
      lm.initialize(['customers']);

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));

      return lm.autoActivateWithRetry('customers', 3).then(() => {
        expect(lm.getState('customers')).toBe('catching-up');
        vi.unstubAllGlobals();
      });
    });

    test('retries on failure and succeeds', () => {
      vi.useFakeTimers();
      const context = createMockContext();
      const lm = createLifecycleManager(context, {
        catchupServiceUrl: 'http://admin:3005',
      });
      lm.initialize(['customers']);

      let callCount = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount < 3) {
            return Promise.reject(new Error('ECONNREFUSED'));
          }
          return Promise.resolve({ ok: true });
        }),
      );

      const p = lm.autoActivateWithRetry('customers', 5);

      const advanceTimers = () =>
        vi.advanceTimersByTimeAsync(60000).then(() => {
          if (callCount < 3) return advanceTimers();
          return Promise.resolve();
        });

      return advanceTimers().then(() =>
        p.then(() => {
          expect(lm.getState('customers')).toBe('catching-up');
          expect(callCount).toBe(3);
          vi.unstubAllGlobals();
          vi.useRealTimers();
        }),
      );
    });

    test('gives up after max retries', () => {
      vi.useFakeTimers();
      const context = createMockContext();
      const lm = createLifecycleManager(context, {
        catchupServiceUrl: 'http://admin:3005',
      });
      lm.initialize(['customers']);

      vi.stubGlobal(
        'fetch',
        vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      );

      const p = lm.autoActivateWithRetry('customers', 2);

      const advanceTimers = () =>
        vi
          .advanceTimersByTimeAsync(60000)
          .then(() => vi.advanceTimersByTimeAsync(60000));

      return advanceTimers().then(() =>
        p.then(() => {
          expect(lm.getState('customers')).toBe('waiting');
          vi.unstubAllGlobals();
          vi.useRealTimers();
        }),
      );
    });
  });
});
