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
  nanoid: vi.fn().mockReturnValue('test-corr-id'),
}));

const { createOrchestrator } = await import('../orchestration.js');

const createMockSseClient = () => {
  const cache = {
    readModels: {},
    getReadModel: vi.fn().mockImplementation((ep, rm) => {
      return cache.readModels[`${ep}/${rm}`] || null;
    }),
    getAllReadModels: vi.fn().mockImplementation(() => ({
      ...cache.readModels,
    })),
    getCommandProcessor: vi.fn().mockReturnValue({
      state: 'idle',
      activeReplays: [],
      activeCatchUps: [],
    }),
    get: vi.fn().mockImplementation(() => ({
      readModels: { ...cache.readModels },
      commandProcessor: {
        state: 'idle',
        activeReplays: [],
        activeCatchUps: [],
      },
    })),
  };

  return {
    cache,
    startOperation: vi.fn().mockResolvedValue(undefined),
    endOperation: vi.fn(),
    ensureConnected: vi.fn().mockResolvedValue(undefined),
    waitForStatus: vi.fn(),
    fetchAllStatus: vi.fn().mockResolvedValue(undefined),
    fetchReplayRelevantEvents: vi
      .fn()
      .mockResolvedValue(['EVENT_A', 'EVENT_B']),
  };
};

const createMockEventBus = () => ({
  publishAdminInstruction: vi.fn().mockReturnValue(vi.fn()),
});

describe('createOrchestrator', () => {
  let sseClient;
  let eventBus;
  let orchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    sseClient = createMockSseClient();
    eventBus = createMockEventBus();
    orchestrator = createOrchestrator({
      sseClient,
      eventBus,
      token: 'test-token',
    });
  });

  describe('replayOrchestration', () => {
    test('executes full replay sequence', () => {
      // Set up the cache with an RM that has a timestamp
      sseClient.cache.readModels['ep1/customers'] = {
        endpointName: 'ep1',
        readModelName: 'customers',
        state: 'stopped',
        lastProjectedEventTimestamp: 5000,
      };

      // waitForStatus resolves immediately for each step
      sseClient.waitForStatus.mockResolvedValue({
        readModels: {
          'ep1/customers': { state: 'stopped' },
        },
        commandProcessor: {
          state: 'idle',
          activeReplays: [],
          activeCatchUps: [],
        },
      });

      return orchestrator.replayOrchestration('ep1', 'customers').then(() => {
        // Should have called startOperation
        expect(sseClient.startOperation).toHaveBeenCalled();
        // Should have published multiple commands
        expect(eventBus.publishAdminInstruction).toHaveBeenCalled();
        // Should have called endOperation
        expect(sseClient.endOperation).toHaveBeenCalled();
      });
    });

    test('calls endOperation on failure', () => {
      sseClient.waitForStatus.mockRejectedValue(
        new Error('Status wait timeout'),
      );

      return orchestrator
        .replayOrchestration('ep1', 'customers')
        .catch((err) => {
          expect(err.message).toBe('Status wait timeout');
          expect(sseClient.endOperation).toHaveBeenCalled();
        });
    });

    test('fetches replayRelevantEvents during sequence', () => {
      sseClient.cache.readModels['ep1/customers'] = {
        endpointName: 'ep1',
        readModelName: 'customers',
        state: 'stopped',
        lastProjectedEventTimestamp: 1000,
      };
      sseClient.waitForStatus.mockResolvedValue({
        readModels: {
          'ep1/customers': { state: 'stopped' },
        },
        commandProcessor: {
          state: 'idle',
          activeReplays: [],
          activeCatchUps: [],
        },
      });

      return orchestrator.replayOrchestration('ep1', 'customers').then(() => {
        expect(sseClient.fetchReplayRelevantEvents).toHaveBeenCalledWith(
          'ep1',
          'customers',
        );
      });
    });
  });

  describe('cancelReplayOrchestration', () => {
    test('publishes cancelReplay and replayDone commands', () => {
      return orchestrator
        .cancelReplayOrchestration('ep1', 'customers')
        .then((result) => {
          expect(result.status).toBe('cancelling');
          expect(eventBus.publishAdminInstruction).toHaveBeenCalled();
        });
    });

    test('publishes reset command when reset option is true', () => {
      const publishFn = vi.fn();
      eventBus.publishAdminInstruction.mockReturnValue(publishFn);

      return orchestrator
        .cancelReplayOrchestration('ep1', 'customers', { reset: true })
        .then(() => {
          const calls = publishFn.mock.calls;
          const resetCall = calls.find((c) => c[0].type === 'reset');
          expect(resetCall).toBeDefined();
        });
    });
  });

  describe('activationOrchestration', () => {
    test('executes full activation sequence', () => {
      sseClient.cache.readModels['ep1/customers'] = {
        endpointName: 'ep1',
        readModelName: 'customers',
        state: 'catchup',
        lastProjectedEventTimestamp: 2000,
      };
      sseClient.waitForStatus.mockResolvedValue({
        readModels: {
          'ep1/customers': { state: 'live' },
        },
        commandProcessor: {
          state: 'idle',
          activeReplays: [],
          activeCatchUps: [],
        },
      });

      return orchestrator
        .activationOrchestration('ep1', 'customers')
        .then((result) => {
          expect(result.status).toBe('live');
          expect(result.endpointName).toBe('ep1');
          expect(result.readModel).toBe('customers');
          expect(eventBus.publishAdminInstruction).toHaveBeenCalled();
        });
    });

    test('fetches replayRelevantEvents for catchup', () => {
      sseClient.cache.readModels['ep1/customers'] = {
        endpointName: 'ep1',
        readModelName: 'customers',
        state: 'catchup',
        lastProjectedEventTimestamp: 500,
      };
      sseClient.waitForStatus.mockResolvedValue({
        readModels: {
          'ep1/customers': { state: 'live' },
        },
        commandProcessor: {
          state: 'idle',
          activeReplays: [],
          activeCatchUps: [],
        },
      });

      return orchestrator
        .activationOrchestration('ep1', 'customers')
        .then(() => {
          expect(sseClient.fetchReplayRelevantEvents).toHaveBeenCalledWith(
            'ep1',
            'customers',
          );
        });
    });
  });

  describe('activateAll', () => {
    test('activates all RMs from cache', () => {
      sseClient.cache.readModels = {
        'ep1/customers': {
          endpointName: 'ep1',
          readModelName: 'customers',
          state: 'stopped',
        },
        'ep1/orders': {
          endpointName: 'ep1',
          readModelName: 'orders',
          state: 'stopped',
        },
      };
      sseClient.cache.getAllReadModels.mockReturnValue({
        ...sseClient.cache.readModels,
      });

      sseClient.waitForStatus.mockResolvedValue({
        readModels: {
          'ep1/customers': { state: 'live' },
          'ep1/orders': { state: 'live' },
        },
        commandProcessor: {
          state: 'idle',
          activeReplays: [],
          activeCatchUps: [],
        },
      });

      return orchestrator.activateAll().then((results) => {
        expect(results).toHaveLength(2);
        expect(sseClient.startOperation).toHaveBeenCalled();
        expect(sseClient.endOperation).toHaveBeenCalled();
      });
    });

    test('returns empty array when no RMs in cache', () => {
      sseClient.cache.getAllReadModels.mockReturnValue({});

      return orchestrator.activateAll().then((results) => {
        expect(results).toEqual([]);
      });
    });
  });
});
