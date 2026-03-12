import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('nanoid', () => ({
  nanoid: vi.fn().mockReturnValue('test-id'),
}));

const { createActivator } = await import('../activator.js');

const createMockEventBus = () => ({
  publishAdminInstruction: vi.fn().mockReturnValue(vi.fn()),
  subscribeAdminReply: vi.fn().mockResolvedValue(undefined),
  subscribeAdminMessages: vi.fn().mockResolvedValue(undefined),
});

describe('createActivator', () => {
  let eventBus;
  let originalFetch;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    eventBus = createMockEventBus();
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const mockFetchResponse = (readModels) => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(readModels),
    });
  };

  const mockFetchError = (status) => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status,
    });
  };

  describe('activateReadModel', () => {
    test('publishes activate instruction on __admin topic', () => {
      const publishFn = vi.fn();
      eventBus.publishAdminInstruction.mockReturnValue(publishFn);

      mockFetchResponse([
        {
          name: 'customers',
          lastProjectedEventTimestamp: 100,
          state: 'catching-up',
        },
      ]);

      const activator = createActivator({
        eventBus,
        correlationConfig: { serviceId: 'TEST' },
        readModelServiceUrl: 'http://localhost:3002',
      });

      return activator.activateReadModel('customers').then(() => {
        expect(eventBus.publishAdminInstruction).toHaveBeenCalled();
        expect(publishFn).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'activate',
            targetReadModel: 'customers',
          }),
        );
      });
    });

    test('includes token when configured', () => {
      const publishFn = vi.fn();
      eventBus.publishAdminInstruction.mockReturnValue(publishFn);

      mockFetchResponse([
        { name: 'customers', lastProjectedEventTimestamp: 0 },
      ]);

      const activator = createActivator({
        eventBus,
        correlationConfig: { serviceId: 'TEST' },
        token: 'secret-token',
        readModelServiceUrl: 'http://localhost:3002',
      });

      return activator.activateReadModel('customers').then(() => {
        expect(publishFn).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'activate',
            token: 'secret-token',
          }),
        );
      });
    });

    test('rejects activation when HTTP request fails', () => {
      const publishFn = vi.fn();
      eventBus.publishAdminInstruction.mockReturnValue(publishFn);

      mockFetchError(500);

      const activator = createActivator({
        eventBus,
        correlationConfig: { serviceId: 'TEST' },
        readModelServiceUrl: 'http://localhost:3002',
      });

      return activator.activateReadModel('unreachable').then(
        () => {
          throw new Error('should not resolve');
        },
        (err) => {
          expect(err.message).toContain('HTTP 500');
        },
      );
    });

    test('queries RM state via HTTP and starts catch-up', () => {
      const publishFn = vi.fn();
      eventBus.publishAdminInstruction.mockReturnValue(publishFn);

      mockFetchResponse([{ name: 'orders', lastProjectedEventTimestamp: 500 }]);

      const activator = createActivator({
        eventBus,
        correlationConfig: { serviceId: 'TEST' },
        readModelServiceUrl: 'http://localhost:3002',
      });

      return activator.activateReadModel('orders').then(() => {
        // Should have fetched from RM service URL
        expect(globalThis.fetch).toHaveBeenCalledWith(
          'http://localhost:3002/admin/readmodels',
          expect.objectContaining({
            headers: expect.objectContaining({
              'Content-Type': 'application/json',
            }),
          }),
        );

        // Should have published start_catchup instruction
        const catchupCall = publishFn.mock.calls.find(
          (c) => c[0].type === 'start_catchup',
        );
        expect(catchupCall).toBeDefined();
        expect(catchupCall[0].readModel).toBe('orders');
        expect(catchupCall[0].fromTimestamp).toBe(500);
      });
    });
  });

  describe('stopReadModel', () => {
    test('publishes stop instruction on __admin topic', () => {
      const publishFn = vi.fn();
      eventBus.publishAdminInstruction.mockReturnValue(publishFn);

      const activator = createActivator({
        eventBus,
        correlationConfig: { serviceId: 'TEST' },
        readModelServiceUrl: 'http://localhost:3002',
      });

      activator.stopReadModel('customers');

      expect(publishFn).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'stop',
          targetReadModel: 'customers',
        }),
      );
    });
  });

  describe('signalCpReady', () => {
    test('publishes set_ready instruction via event bus', () => {
      const publishFn = vi.fn();
      eventBus.publishAdminInstruction.mockReturnValue(publishFn);

      const activator = createActivator({
        eventBus,
        correlationConfig: { serviceId: 'TEST' },
        readModelServiceUrl: 'http://localhost:3002',
      });

      return activator.signalCpReady().then((result) => {
        expect(publishFn).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'set_ready',
          }),
        );
        expect(result).toEqual({ status: 'ready' });
      });
    });

    test('includes token when configured', () => {
      const publishFn = vi.fn();
      eventBus.publishAdminInstruction.mockReturnValue(publishFn);

      const activator = createActivator({
        eventBus,
        correlationConfig: { serviceId: 'TEST' },
        token: 'my-token',
        readModelServiceUrl: 'http://localhost:3002',
      });

      return activator.signalCpReady().then(() => {
        expect(publishFn).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'set_ready',
            token: 'my-token',
          }),
        );
      });
    });
  });

  describe('queryReadModelState', () => {
    test('queries and returns specific read model state via HTTP', () => {
      mockFetchResponse([
        {
          name: 'customers',
          state: 'live',
          lastProjectedEventTimestamp: 999,
        },
      ]);

      const activator = createActivator({
        eventBus,
        correlationConfig: { serviceId: 'TEST' },
        readModelServiceUrl: 'http://localhost:3002',
      });

      return activator.queryReadModelState('customers').then((rm) => {
        expect(rm.name).toBe('customers');
        expect(rm.state).toBe('live');
        expect(globalThis.fetch).toHaveBeenCalledWith(
          'http://localhost:3002/admin/readmodels',
          expect.any(Object),
        );
      });
    });

    test('includes Authorization header when token is configured', () => {
      mockFetchResponse([
        { name: 'customers', state: 'live', lastProjectedEventTimestamp: 0 },
      ]);

      const activator = createActivator({
        eventBus,
        correlationConfig: { serviceId: 'TEST' },
        token: 'secret-token',
        readModelServiceUrl: 'http://localhost:3002',
      });

      return activator.queryReadModelState('customers').then(() => {
        expect(globalThis.fetch).toHaveBeenCalledWith(
          'http://localhost:3002/admin/readmodels',
          expect.objectContaining({
            headers: expect.objectContaining({
              Authorization: 'Bearer secret-token',
            }),
          }),
        );
      });
    });

    test('rejects when read model not found in response', () => {
      mockFetchResponse([{ name: 'other' }]);

      const activator = createActivator({
        eventBus,
        correlationConfig: { serviceId: 'TEST' },
        readModelServiceUrl: 'http://localhost:3002',
      });

      return activator.queryReadModelState('missing').then(
        () => {
          throw new Error('should not resolve');
        },
        (err) => {
          expect(err.message).toContain('not found');
        },
      );
    });

    test('rejects on HTTP error', () => {
      mockFetchError(503);

      const activator = createActivator({
        eventBus,
        correlationConfig: { serviceId: 'TEST' },
        readModelServiceUrl: 'http://localhost:3002',
      });

      return activator.queryReadModelState('missing').then(
        () => {
          throw new Error('should not resolve');
        },
        (err) => {
          expect(err.message).toContain('HTTP 503');
        },
      );
    });

    test('rejects when readModelServiceUrl is not configured', () => {
      const activator = createActivator({
        eventBus,
        correlationConfig: { serviceId: 'TEST' },
      });

      return activator.queryReadModelState('customers').then(
        () => {
          throw new Error('should not resolve');
        },
        (err) => {
          expect(err.message).toContain('readModelServiceUrl is required');
        },
      );
    });
  });

  describe('restartReadModel', () => {
    test('publishes restart instruction then re-activates', () => {
      const publishFn = vi.fn();
      eventBus.publishAdminInstruction.mockReturnValue(publishFn);

      mockFetchResponse([
        { name: 'customers', lastProjectedEventTimestamp: 0 },
      ]);

      const activator = createActivator({
        eventBus,
        correlationConfig: { serviceId: 'TEST' },
        readModelServiceUrl: 'http://localhost:3002',
      });

      return activator.restartReadModel('customers').then(() => {
        // First call should be restart instruction
        const firstInstruction = publishFn.mock.calls[0][0];
        expect(firstInstruction.type).toBe('restart');
        expect(firstInstruction.targetReadModel).toBe('customers');

        // Should have also published activate (re-activation after restart)
        const activateCall = publishFn.mock.calls.find(
          (c) => c[0].type === 'activate',
        );
        expect(activateCall).toBeDefined();
      });
    });
  });
});
