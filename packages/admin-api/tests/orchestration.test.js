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
      state: 'live',
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
    fetchLastEventStoreTimestamp: vi.fn().mockResolvedValue(9000),
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
        state: 'idle',
        lastProjectedEventTimestamp: 5000,
      };

      // waitForStatus resolves immediately for each step
      sseClient.waitForStatus.mockResolvedValue({
        readModels: {
          'ep1/customers': { state: 'idle' },
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

    test('skips activation when activateAfter is false', () => {
      sseClient.cache.readModels['ep1/customers'] = {
        endpointName: 'ep1',
        readModelName: 'customers',
        state: 'idle',
        lastProjectedEventTimestamp: 5000,
      };

      sseClient.waitForStatus.mockResolvedValue({
        readModels: {
          'ep1/customers': { state: 'idle' },
        },
        commandProcessor: {
          state: 'idle',
          activeReplays: [],
          activeCatchUps: [],
        },
      });

      return orchestrator
        .replayOrchestration('ep1', 'customers', { activateAfter: false })
        .then((result) => {
          expect(result).toEqual({
            status: 'replay-done',
            endpointName: 'ep1',
            readModel: 'customers',
          });
          expect(sseClient.endOperation).toHaveBeenCalled();
          // Activation commands (activate, startCatchup, catchupDone) should
          // NOT have been published — only replay-related commands.
          const publishFn =
            eventBus.publishAdminInstruction.mock.results[0].value;
          const publishedTypes = publishFn.mock.calls.map((c) => c[0].type);
          expect(publishedTypes).not.toContain('activate');
          expect(publishedTypes).not.toContain('startCatchup');
          expect(publishedTypes).not.toContain('catchupDone');
        });
    });

    test('fetches replayRelevantEvents during sequence', () => {
      sseClient.cache.readModels['ep1/customers'] = {
        endpointName: 'ep1',
        readModelName: 'customers',
        state: 'idle',
        lastProjectedEventTimestamp: 1000,
      };
      sseClient.waitForStatus.mockResolvedValue({
        readModels: {
          'ep1/customers': { state: 'idle' },
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
          state: 'idle',
        },
        'ep1/orders': {
          endpointName: 'ep1',
          readModelName: 'orders',
          state: 'idle',
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

  describe('replayOrchestration with T=0 options', () => {
    const setupStandardMocks = () => {
      sseClient.cache.readModels['ep1/customers'] = {
        endpointName: 'ep1',
        readModelName: 'customers',
        state: 'idle',
        lastProjectedEventTimestamp: 0,
      };

      sseClient.waitForStatus.mockResolvedValue({
        readModels: {
          'ep1/customers': { state: 'idle' },
        },
        commandProcessor: {
          state: 'idle',
          activeReplays: [],
          activeCatchUps: [],
        },
      });
    };

    test('option 1 (replayToCurrentTime) fetches last event store timestamp', () => {
      setupStandardMocks();
      sseClient.fetchLastEventStoreTimestamp.mockResolvedValue(9000);

      return orchestrator
        .replayOrchestration('ep1', 'customers', {
          t0Option: 'replayToCurrentTime',
        })
        .then(() => {
          expect(sseClient.fetchLastEventStoreTimestamp).toHaveBeenCalled();
          // Should have published a replay command with toTimestamp=9000
          const publishFn =
            eventBus.publishAdminInstruction.mock.results[0].value;
          const replayCall = publishFn.mock.calls.find(
            (c) => c[0].type === 'replay',
          );
          expect(replayCall).toBeDefined();
          expect(replayCall[0].toTimestamp).toBe(9000);
        });
    });

    test('option 1 fails when event store timestamp is unavailable', () => {
      setupStandardMocks();
      sseClient.fetchLastEventStoreTimestamp.mockResolvedValue(null);

      return orchestrator
        .replayOrchestration('ep1', 'customers', {
          t0Option: 'replayToCurrentTime',
        })
        .then(() => {
          throw new Error('should not resolve');
        })
        .catch((err) => {
          expect(err.message).toContain('event store timestamp unavailable');
          expect(sseClient.endOperation).toHaveBeenCalled();
        });
    });

    test('option 1 persists timestamp to both storages', () => {
      setupStandardMocks();
      sseClient.fetchLastEventStoreTimestamp.mockResolvedValue(9000);

      return orchestrator
        .replayOrchestration('ep1', 'customers', {
          t0Option: 'replayToCurrentTime',
        })
        .then(() => {
          const publishFn =
            eventBus.publishAdminInstruction.mock.results[0].value;
          const persistCall = publishFn.mock.calls.find(
            (c) => c[0].type === 'persistTimestamp',
          );
          expect(persistCall).toBeDefined();
          expect(persistCall[0].timestamp).toBe(9000);
          expect(persistCall[0].targetReadModel).toBe('customers');
        });
    });

    test('option 2 (skipReplayCatchUpOnly) skips replay and activates', () => {
      setupStandardMocks();

      return orchestrator
        .replayOrchestration('ep1', 'customers', {
          t0Option: 'skipReplayCatchUpOnly',
        })
        .then(() => {
          // Should NOT have published a replay command
          const publishFn =
            eventBus.publishAdminInstruction.mock.results[0].value;
          const replayCall = publishFn.mock.calls.find(
            (c) => c[0].type === 'replay',
          );
          expect(replayCall).toBeUndefined();

          // Should have published stop and reset
          const stopCall = publishFn.mock.calls.find(
            (c) => c[0].type === 'stop',
          );
          expect(stopCall).toBeDefined();
          const resetCall = publishFn.mock.calls.find(
            (c) => c[0].type === 'reset',
          );
          expect(resetCall).toBeDefined();

          expect(sseClient.endOperation).toHaveBeenCalled();
        });
    });

    test('option 2 with activateAfter=false returns warning', () => {
      setupStandardMocks();

      return orchestrator
        .replayOrchestration('ep1', 'customers', {
          t0Option: 'skipReplayCatchUpOnly',
          activateAfter: false,
        })
        .then((result) => {
          expect(result.status).toBe('idle');
          expect(result.warning).toContain('skipReplayCatchUpOnly');
          expect(sseClient.endOperation).toHaveBeenCalled();
        });
    });

    test('option 3 (customBoundary) uses custom timestamp', () => {
      setupStandardMocks();

      return orchestrator
        .replayOrchestration('ep1', 'customers', {
          t0Option: 'customBoundary',
          customTimestamp: 4500,
        })
        .then(() => {
          const publishFn =
            eventBus.publishAdminInstruction.mock.results[0].value;
          const replayCall = publishFn.mock.calls.find(
            (c) => c[0].type === 'replay',
          );
          expect(replayCall).toBeDefined();
          expect(replayCall[0].toTimestamp).toBe(4500);
        });
    });

    test('option 3 persists custom timestamp to both storages', () => {
      setupStandardMocks();

      return orchestrator
        .replayOrchestration('ep1', 'customers', {
          t0Option: 'customBoundary',
          customTimestamp: 4500,
        })
        .then(() => {
          const publishFn =
            eventBus.publishAdminInstruction.mock.results[0].value;
          const persistCall = publishFn.mock.calls.find(
            (c) => c[0].type === 'persistTimestamp',
          );
          expect(persistCall).toBeDefined();
          expect(persistCall[0].timestamp).toBe(4500);
        });
    });

    test('option 3 fails when customTimestamp is missing', () => {
      setupStandardMocks();

      return orchestrator
        .replayOrchestration('ep1', 'customers', {
          t0Option: 'customBoundary',
        })
        .then(() => {
          throw new Error('should not resolve');
        })
        .catch((err) => {
          expect(err.message).toContain('customBoundary requires');
          expect(sseClient.endOperation).toHaveBeenCalled();
        });
    });

    test('unknown t0Option rejects', () => {
      setupStandardMocks();

      return orchestrator
        .replayOrchestration('ep1', 'customers', {
          t0Option: 'invalidOption',
        })
        .then(() => {
          throw new Error('should not resolve');
        })
        .catch((err) => {
          expect(err.message).toContain('Unknown t0Option');
          expect(sseClient.endOperation).toHaveBeenCalled();
        });
    });

    test('standard replay (no t0Option) uses RM lastProjectedEventTimestamp', () => {
      sseClient.cache.readModels['ep1/customers'] = {
        endpointName: 'ep1',
        readModelName: 'customers',
        state: 'idle',
        lastProjectedEventTimestamp: 5000,
      };

      sseClient.waitForStatus.mockResolvedValue({
        readModels: {
          'ep1/customers': { state: 'idle' },
        },
        commandProcessor: {
          state: 'idle',
          activeReplays: [],
          activeCatchUps: [],
        },
      });

      return orchestrator.replayOrchestration('ep1', 'customers').then(() => {
        // Should NOT have called fetchLastEventStoreTimestamp
        expect(sseClient.fetchLastEventStoreTimestamp).not.toHaveBeenCalled();

        const publishFn =
          eventBus.publishAdminInstruction.mock.results[0].value;
        const replayCall = publishFn.mock.calls.find(
          (c) => c[0].type === 'replay',
        );
        expect(replayCall[0].toTimestamp).toBe(5000);

        // Should NOT have published persistTimestamp
        const persistCall = publishFn.mock.calls.find(
          (c) => c[0].type === 'persistTimestamp',
        );
        expect(persistCall).toBeUndefined();
      });
    });
  });

  describe('backupReplayOrchestration with T=0 options', () => {
    const setupBackupMocks = (backupTimestamp = 3000) => {
      sseClient.cache.readModels['ep1/customers'] = {
        endpointName: 'ep1',
        readModelName: 'customers',
        state: 'idle',
        lastProjectedEventTimestamp: backupTimestamp,
      };

      sseClient.waitForStatus.mockResolvedValue({
        readModels: {
          'ep1/customers': { state: 'idle' },
        },
        commandProcessor: {
          state: 'idle',
          activeReplays: [],
          activeCatchUps: [],
        },
      });
    };

    test('acceptLastEvent: fetches event store timestamp and replays from backup ts', () => {
      setupBackupMocks(3000);
      sseClient.fetchLastEventStoreTimestamp.mockResolvedValue(9000);

      return orchestrator
        .backupReplayOrchestration('ep1', 'customers', {
          backupId: 'b1',
          t0Option: 'acceptLastEvent',
        })
        .then(() => {
          expect(sseClient.fetchLastEventStoreTimestamp).toHaveBeenCalled();

          const publishFn =
            eventBus.publishAdminInstruction.mock.results[0].value;

          // Should restore backup
          const restoreCall = publishFn.mock.calls.find(
            (c) => c[0].type === 'restoreBackup',
          );
          expect(restoreCall).toBeDefined();
          expect(restoreCall[0].backupId).toBe('b1');

          // Should replay from backupTs to eventStoreTs
          const replayCall = publishFn.mock.calls.find(
            (c) => c[0].type === 'replay',
          );
          expect(replayCall).toBeDefined();
          expect(replayCall[0].fromTimestamp).toBe(3000);
          expect(replayCall[0].toTimestamp).toBe(9000);

          // Should persist timestamp
          const persistCall = publishFn.mock.calls.find(
            (c) => c[0].type === 'persistTimestamp',
          );
          expect(persistCall).toBeDefined();
          expect(persistCall[0].timestamp).toBe(9000);
        });
    });

    test('acceptLastEvent: fails when event store timestamp unavailable', () => {
      setupBackupMocks(3000);
      sseClient.fetchLastEventStoreTimestamp.mockResolvedValue(null);

      return orchestrator
        .backupReplayOrchestration('ep1', 'customers', {
          backupId: 'b1',
          t0Option: 'acceptLastEvent',
        })
        .then(() => {
          throw new Error('should not resolve');
        })
        .catch((err) => {
          expect(err.message).toContain('event store timestamp unavailable');
          expect(sseClient.endOperation).toHaveBeenCalled();
        });
    });

    test('acceptBackupTimestamp: skips replay, activates directly', () => {
      setupBackupMocks(3000);

      return orchestrator
        .backupReplayOrchestration('ep1', 'customers', {
          backupId: 'b1',
          t0Option: 'acceptBackupTimestamp',
        })
        .then(() => {
          const publishFn =
            eventBus.publishAdminInstruction.mock.results[0].value;

          // Should restore backup
          const restoreCall = publishFn.mock.calls.find(
            (c) => c[0].type === 'restoreBackup',
          );
          expect(restoreCall).toBeDefined();

          // Should NOT send replay command
          const replayCall = publishFn.mock.calls.find(
            (c) => c[0].type === 'replay',
          );
          expect(replayCall).toBeUndefined();

          // Should persist backup timestamp
          const persistCall = publishFn.mock.calls.find(
            (c) => c[0].type === 'persistTimestamp',
          );
          expect(persistCall).toBeDefined();
          expect(persistCall[0].timestamp).toBe(3000);

          expect(sseClient.endOperation).toHaveBeenCalled();
        });
    });

    test('acceptBackupTimestamp with activateAfter=false returns stopped', () => {
      setupBackupMocks(3000);

      return orchestrator
        .backupReplayOrchestration('ep1', 'customers', {
          backupId: 'b1',
          t0Option: 'acceptBackupTimestamp',
          activateAfter: false,
        })
        .then((result) => {
          expect(result.status).toBe('idle');
          expect(sseClient.endOperation).toHaveBeenCalled();
        });
    });

    test('customBoundary: replays from backup timestamp to custom value', () => {
      setupBackupMocks(3000);

      return orchestrator
        .backupReplayOrchestration('ep1', 'customers', {
          backupId: 'b1',
          t0Option: 'customBoundary',
          customTimestamp: 7000,
        })
        .then(() => {
          const publishFn =
            eventBus.publishAdminInstruction.mock.results[0].value;

          const replayCall = publishFn.mock.calls.find(
            (c) => c[0].type === 'replay',
          );
          expect(replayCall).toBeDefined();
          expect(replayCall[0].fromTimestamp).toBe(3000);
          expect(replayCall[0].toTimestamp).toBe(7000);

          const persistCall = publishFn.mock.calls.find(
            (c) => c[0].type === 'persistTimestamp',
          );
          expect(persistCall).toBeDefined();
          expect(persistCall[0].timestamp).toBe(7000);
        });
    });

    test('customBoundary: fails when customTimestamp is missing', () => {
      setupBackupMocks(3000);

      return orchestrator
        .backupReplayOrchestration('ep1', 'customers', {
          backupId: 'b1',
          t0Option: 'customBoundary',
        })
        .then(() => {
          throw new Error('should not resolve');
        })
        .catch((err) => {
          expect(err.message).toContain('requires a valid timestamp');
          expect(sseClient.endOperation).toHaveBeenCalled();
        });
    });

    test('calls endOperation on failure', () => {
      sseClient.waitForStatus.mockRejectedValue(
        new Error('Status wait timeout'),
      );

      return orchestrator
        .backupReplayOrchestration('ep1', 'customers', {
          backupId: 'b1',
          t0Option: 'acceptLastEvent',
        })
        .catch((err) => {
          expect(err.message).toBe('Status wait timeout');
          expect(sseClient.endOperation).toHaveBeenCalled();
        });
    });
  });

  describe('activationOrchestration operation bracketing', () => {
    const mockAllWaitsResolved = () => {
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
    };

    test('brackets a single activation with startOperation/endOperation', () => {
      sseClient.cache.readModels['ep1/customers'] = {
        endpointName: 'ep1',
        readModelName: 'customers',
        state: 'idle',
        lastProjectedEventTimestamp: 5000,
      };
      mockAllWaitsResolved();

      return orchestrator
        .activationOrchestration('ep1', 'customers')
        .then(() => {
          expect(sseClient.startOperation).toHaveBeenCalled();
          expect(sseClient.endOperation).toHaveBeenCalled();
        });
    });

    test('calls endOperation when a single activation fails', () => {
      sseClient.waitForStatus.mockRejectedValue(
        new Error('Status wait timeout'),
      );

      return orchestrator.activationOrchestration('ep1', 'customers').then(
        () => {
          throw new Error('should not resolve');
        },
        (err) => {
          expect(err.message).toBe('Status wait timeout');
          expect(sseClient.endOperation).toHaveBeenCalled();
          expect(sseClient.endOperation.mock.calls.length).toBe(
            sseClient.startOperation.mock.calls.length,
          );
        },
      );
    });

    test('activateAll starts the operation before reading the cache', () => {
      // Simulate a cold cache that only becomes populated once the
      // operation has started (startOperation connects and fetches status)
      let opStarted = false;
      sseClient.startOperation.mockImplementation(() => {
        opStarted = true;
        return Promise.resolve();
      });
      sseClient.cache.getAllReadModels.mockImplementation(() =>
        opStarted
          ? {
              'ep1/customers': {
                endpointName: 'ep1',
                readModelName: 'customers',
                state: 'idle',
                lastProjectedEventTimestamp: 0,
              },
            }
          : {},
      );
      mockAllWaitsResolved();

      return orchestrator.activateAll().then((results) => {
        expect(results).toHaveLength(1);
        expect(sseClient.endOperation).toHaveBeenCalled();
      });
    });
  });
});
