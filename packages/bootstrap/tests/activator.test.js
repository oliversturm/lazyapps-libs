import { describe, test, expect, vi, beforeEach } from 'vitest';

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
});

describe('createActivator', () => {
  let eventBus;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    eventBus = createMockEventBus();
  });

  describe('activateReadModel', () => {
    test('publishes activate instruction on __admin topic', () => {
      const publishFn = vi.fn();
      eventBus.publishAdminInstruction.mockReturnValue(publishFn);

      const activator = createActivator({
        eventBus,
        adminReadModelServices: JSON.stringify({
          default: 'http://localhost:3000',
        }),
        commandProcessorUrl: 'http://localhost:3001',
        correlationConfig: { serviceId: 'TEST' },
      });

      // Mock fetch to avoid real HTTP calls
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve([
            {
              name: 'customers',
              lastProjectedEventTimestamp: 100,
              state: 'catching-up',
            },
          ]),
      });
      vi.stubGlobal('fetch', mockFetch);

      return activator.activateReadModel('customers').then(() => {
        expect(eventBus.publishAdminInstruction).toHaveBeenCalled();
        expect(publishFn).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'activate',
            targetReadModel: 'customers',
          }),
        );
        vi.unstubAllGlobals();
      });
    });

    test('includes token when configured', () => {
      const publishFn = vi.fn();
      eventBus.publishAdminInstruction.mockReturnValue(publishFn);

      const activator = createActivator({
        eventBus,
        adminReadModelServices: JSON.stringify({
          default: 'http://localhost:3000',
        }),
        commandProcessorUrl: 'http://localhost:3001',
        correlationConfig: { serviceId: 'TEST' },
        token: 'secret-token',
      });

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve([
            { name: 'customers', lastProjectedEventTimestamp: 0 },
          ]),
      });
      vi.stubGlobal('fetch', mockFetch);

      return activator.activateReadModel('customers').then(() => {
        expect(publishFn).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'activate',
            token: 'secret-token',
          }),
        );
        // Verify token in HTTP headers
        expect(mockFetch).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            headers: expect.objectContaining({
              Authorization: 'Bearer secret-token',
            }),
          }),
        );
        vi.unstubAllGlobals();
      });
    });

    test('rejects when no service URL configured for read model', () => {
      const activator = createActivator({
        eventBus,
        adminReadModelServices: JSON.stringify({}),
        commandProcessorUrl: 'http://localhost:3001',
        correlationConfig: { serviceId: 'TEST' },
      });

      return activator.activateReadModel('unknown').then(
        () => {
          throw new Error('should not resolve');
        },
        (err) => {
          expect(err.message).toContain('No read model service URL');
        },
      );
    });

    test('queries RM state and calls CP catch-up endpoint', () => {
      const activator = createActivator({
        eventBus,
        adminReadModelServices: JSON.stringify({
          default: 'http://rm:3000',
        }),
        commandProcessorUrl: 'http://cp:3001',
        correlationConfig: { serviceId: 'TEST' },
      });

      const mockFetch = vi.fn().mockImplementation((url) => {
        if (url.includes('/admin/readmodels')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve([
                { name: 'orders', lastProjectedEventTimestamp: 500 },
              ]),
          });
        }
        if (url.includes('/admin/catchup/')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ started: true }),
          });
        }
        return Promise.reject(new Error(`Unexpected URL: ${url}`));
      });
      vi.stubGlobal('fetch', mockFetch);

      return activator.activateReadModel('orders').then(() => {
        // Should have queried RM state
        const rmCall = mockFetch.mock.calls.find((c) =>
          c[0].includes('/admin/readmodels'),
        );
        expect(rmCall).toBeDefined();
        expect(rmCall[0]).toBe('http://rm:3000/admin/readmodels');

        // Should have called CP catch-up
        const cpCall = mockFetch.mock.calls.find((c) =>
          c[0].includes('/admin/catchup/'),
        );
        expect(cpCall).toBeDefined();
        expect(cpCall[0]).toBe('http://cp:3001/admin/catchup/orders/start');
        const cpBody = JSON.parse(cpCall[1].body);
        expect(cpBody.fromTimestamp).toBe(500);
        expect(cpBody.serviceId).toBe('TEST');
        vi.unstubAllGlobals();
      });
    });
  });

  describe('stopReadModel', () => {
    test('publishes stop instruction on __admin topic', () => {
      const publishFn = vi.fn();
      eventBus.publishAdminInstruction.mockReturnValue(publishFn);

      const activator = createActivator({
        eventBus,
        adminReadModelServices: '{}',
        commandProcessorUrl: 'http://localhost:3001',
        correlationConfig: { serviceId: 'TEST' },
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
    test('sends POST to CP /admin/ready endpoint', () => {
      const activator = createActivator({
        eventBus,
        adminReadModelServices: '{}',
        commandProcessorUrl: 'http://cp:3001',
        correlationConfig: { serviceId: 'TEST' },
      });

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: 'ready' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      return activator.signalCpReady().then((result) => {
        expect(mockFetch).toHaveBeenCalledWith(
          'http://cp:3001/admin/ready',
          expect.objectContaining({ method: 'POST' }),
        );
        expect(result).toEqual({ status: 'ready' });
        vi.unstubAllGlobals();
      });
    });

    test('includes token in Authorization header when configured', () => {
      const activator = createActivator({
        eventBus,
        adminReadModelServices: '{}',
        commandProcessorUrl: 'http://cp:3001',
        correlationConfig: { serviceId: 'TEST' },
        token: 'my-token',
      });

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ status: 'ready' }),
      });
      vi.stubGlobal('fetch', mockFetch);

      return activator.signalCpReady().then(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            headers: expect.objectContaining({
              Authorization: 'Bearer my-token',
            }),
          }),
        );
        vi.unstubAllGlobals();
      });
    });
  });

  describe('queryReadModelState', () => {
    test('fetches and returns specific read model state', () => {
      const activator = createActivator({
        eventBus,
        adminReadModelServices: JSON.stringify({
          customers: 'http://rm1:3000',
        }),
        commandProcessorUrl: 'http://cp:3001',
        correlationConfig: { serviceId: 'TEST' },
      });

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve([
            {
              name: 'customers',
              state: 'live',
              lastProjectedEventTimestamp: 999,
            },
          ]),
      });
      vi.stubGlobal('fetch', mockFetch);

      return activator.queryReadModelState('customers').then((rm) => {
        expect(rm.name).toBe('customers');
        expect(rm.state).toBe('live');
        vi.unstubAllGlobals();
      });
    });

    test('rejects when read model not found in response', () => {
      const activator = createActivator({
        eventBus,
        adminReadModelServices: JSON.stringify({
          default: 'http://rm:3000',
        }),
        commandProcessorUrl: 'http://cp:3001',
        correlationConfig: { serviceId: 'TEST' },
      });

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve([{ name: 'other' }]),
      });
      vi.stubGlobal('fetch', mockFetch);

      return activator.queryReadModelState('missing').then(
        () => {
          throw new Error('should not resolve');
        },
        (err) => {
          expect(err.message).toContain('not found');
          vi.unstubAllGlobals();
        },
      );
    });

    test('rejects when no service URL configured', () => {
      const activator = createActivator({
        eventBus,
        adminReadModelServices: JSON.stringify({}),
        commandProcessorUrl: 'http://cp:3001',
        correlationConfig: { serviceId: 'TEST' },
      });

      return activator.queryReadModelState('missing').then(
        () => {
          throw new Error('should not resolve');
        },
        (err) => {
          expect(err.message).toContain('No read model service URL');
        },
      );
    });
  });

  describe('restartReadModel', () => {
    test('publishes restart instruction then re-activates', () => {
      const publishFn = vi.fn();
      eventBus.publishAdminInstruction.mockReturnValue(publishFn);

      const activator = createActivator({
        eventBus,
        adminReadModelServices: JSON.stringify({
          default: 'http://rm:3000',
        }),
        commandProcessorUrl: 'http://cp:3001',
        correlationConfig: { serviceId: 'TEST' },
      });

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve([
            { name: 'customers', lastProjectedEventTimestamp: 0 },
          ]),
      });
      vi.stubGlobal('fetch', mockFetch);

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
        vi.unstubAllGlobals();
      });
    });
  });
});
