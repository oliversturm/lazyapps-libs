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
  subscribeAdminReply: vi.fn().mockResolvedValue(undefined),
  subscribeAdminMessages: vi.fn().mockResolvedValue(undefined),
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

      // subscribeAdminReply triggers the handler with mock state data
      eventBus.subscribeAdminReply.mockImplementation((topic, handler) => {
        setTimeout(() =>
          handler({
            readModels: [
              {
                name: 'customers',
                lastProjectedEventTimestamp: 100,
                state: 'catching-up',
              },
            ],
          }),
        );
        return Promise.resolve();
      });

      const activator = createActivator({
        eventBus,
        correlationConfig: { serviceId: 'TEST' },
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

      eventBus.subscribeAdminReply.mockImplementation((topic, handler) => {
        setTimeout(() =>
          handler({
            readModels: [{ name: 'customers', lastProjectedEventTimestamp: 0 }],
          }),
        );
        return Promise.resolve();
      });

      const activator = createActivator({
        eventBus,
        correlationConfig: { serviceId: 'TEST' },
        token: 'secret-token',
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

    test('rejects activation when query_state gets no reply', () => {
      const publishFn = vi.fn();
      eventBus.publishAdminInstruction.mockReturnValue(publishFn);

      // subscribeAdminReply never calls handler → timeout
      eventBus.subscribeAdminReply.mockResolvedValue(undefined);

      const activator = createActivator({
        eventBus,
        correlationConfig: { serviceId: 'TEST' },
      });

      return activator.activateReadModel('unreachable').then(
        () => {
          throw new Error('should not resolve');
        },
        (err) => {
          expect(err.message).toContain('Timed out');
        },
      );
    }, 10000);

    test('queries RM state via event bus and starts catch-up', () => {
      const publishFn = vi.fn();
      eventBus.publishAdminInstruction.mockReturnValue(publishFn);

      eventBus.subscribeAdminReply.mockImplementation((topic, handler) => {
        setTimeout(() =>
          handler({
            readModels: [{ name: 'orders', lastProjectedEventTimestamp: 500 }],
          }),
        );
        return Promise.resolve();
      });

      const activator = createActivator({
        eventBus,
        correlationConfig: { serviceId: 'TEST' },
      });

      return activator.activateReadModel('orders').then(() => {
        // Should have published query_state instruction
        const queryStateCall = publishFn.mock.calls.find(
          (c) => c[0].type === 'query_state',
        );
        expect(queryStateCall).toBeDefined();
        expect(queryStateCall[0].replyTopic).toBeDefined();

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
    test('queries and returns specific read model state via event bus', () => {
      eventBus.subscribeAdminReply.mockImplementation((topic, handler) => {
        setTimeout(() =>
          handler({
            readModels: [
              {
                name: 'customers',
                state: 'live',
                lastProjectedEventTimestamp: 999,
              },
            ],
          }),
        );
        return Promise.resolve();
      });

      const activator = createActivator({
        eventBus,
        correlationConfig: { serviceId: 'TEST' },
      });

      return activator.queryReadModelState('customers').then((rm) => {
        expect(rm.name).toBe('customers');
        expect(rm.state).toBe('live');
      });
    });

    test('rejects when read model not found in response', () => {
      eventBus.subscribeAdminReply.mockImplementation((topic, handler) => {
        setTimeout(() =>
          handler({
            readModels: [{ name: 'other' }],
          }),
        );
        return Promise.resolve();
      });

      const activator = createActivator({
        eventBus,
        correlationConfig: { serviceId: 'TEST' },
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

    test('rejects on timeout when no reply received', () => {
      // subscribeAdminReply never calls handler → timeout
      eventBus.subscribeAdminReply.mockResolvedValue(undefined);

      const activator = createActivator({
        eventBus,
        correlationConfig: { serviceId: 'TEST' },
      });

      return activator.queryReadModelState('missing').then(
        () => {
          throw new Error('should not resolve');
        },
        (err) => {
          expect(err.message).toContain('Timed out');
        },
      );
    }, 10000);
  });

  describe('restartReadModel', () => {
    test('publishes restart instruction then re-activates', () => {
      const publishFn = vi.fn();
      eventBus.publishAdminInstruction.mockReturnValue(publishFn);

      eventBus.subscribeAdminReply.mockImplementation((topic, handler) => {
        setTimeout(() =>
          handler({
            readModels: [{ name: 'customers', lastProjectedEventTimestamp: 0 }],
          }),
        );
        return Promise.resolve();
      });

      const activator = createActivator({
        eventBus,
        correlationConfig: { serviceId: 'TEST' },
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
