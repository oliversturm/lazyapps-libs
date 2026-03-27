import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { createStatusTracker } = await import('../statusTracker.js');

describe('statusTracker', () => {
  let tracker;
  const readModels = {
    customers: { lastProjectedEventTimestamp: 500 },
    orders: { lastProjectedEventTimestamp: 0 },
  };

  beforeEach(() => {
    vi.useFakeTimers();
    tracker = createStatusTracker(readModels, 'ep1');
    tracker.initialize(['customers', 'orders']);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('initialize', () => {
    test('sets initial status for all read models', () => {
      const status = tracker.getStatus('customers');
      expect(status).toEqual({
        endpointName: 'ep1',
        readModelName: 'customers',
        state: 'idle',
        stateVersion: 0,
        lastProjectedEventTimestamp: 500,
        correlationId: null,
        replayProgress: null,
        catchupProgress: null,
        backupProgress: { state: 'idle' },
      });
    });

    test('initializes with zero timestamp when RM has none', () => {
      const status = tracker.getStatus('orders');
      expect(status.lastProjectedEventTimestamp).toBe(0);
    });

    test('uses default endpointName when none provided', () => {
      const t = createStatusTracker(readModels);
      t.initialize(['customers']);
      expect(t.getStatus('customers').endpointName).toBe('default');
    });
  });

  describe('getStatus', () => {
    test('returns null for unknown read model', () => {
      expect(tracker.getStatus('nonexistent')).toBeNull();
    });

    test('returns a copy, not the original', () => {
      const s1 = tracker.getStatus('customers');
      s1.state = 'live';
      expect(tracker.getStatus('customers').state).toBe('idle');
    });
  });

  describe('getAllStatuses', () => {
    test('returns all statuses', () => {
      const all = tracker.getAllStatuses();
      expect(all).toHaveLength(2);
      expect(all.map((s) => s.readModelName).sort()).toEqual([
        'customers',
        'orders',
      ]);
    });

    test('returns copies', () => {
      const all = tracker.getAllStatuses();
      all[0].state = 'live';
      expect(tracker.getStatus(all[0].readModelName).state).toBe('idle');
    });
  });

  describe('setState', () => {
    test('updates state and pushes SSE immediately', () => {
      const mockRes = { write: vi.fn() };
      tracker.addSseClient(mockRes);
      // Clear initial status push
      mockRes.write.mockClear();

      tracker.setState('customers', 'live', 'corr-1');

      expect(tracker.getStatus('customers').state).toBe('live');
      expect(tracker.getStatus('customers').correlationId).toBe('corr-1');
      // Should have pushed immediately
      expect(mockRes.write).toHaveBeenCalledOnce();
      const written = mockRes.write.mock.calls[0][0];
      expect(written).toContain('event: status-change');
      expect(written).toContain('"state":"live"');
    });

    test('does nothing for unknown read model', () => {
      tracker.setState('nonexistent', 'live', 'corr-1');
      expect(tracker.getStatus('nonexistent')).toBeNull();
    });
  });

  describe('updateProgress', () => {
    test('updates progress field and debounces push', () => {
      const mockRes = { write: vi.fn() };
      tracker.addSseClient(mockRes);
      mockRes.write.mockClear();

      tracker.updateProgress('customers', 'replayProgress', {
        eventsProcessed: 50,
      });

      // Should not push immediately
      expect(mockRes.write).not.toHaveBeenCalled();

      // After debounce interval
      vi.advanceTimersByTime(100);
      expect(mockRes.write).toHaveBeenCalledOnce();
      const written = mockRes.write.mock.calls[0][0];
      expect(written).toContain('"eventsProcessed":50');
    });

    test('pushes after event count threshold', () => {
      const mockRes = { write: vi.fn() };
      tracker.addSseClient(mockRes);
      mockRes.write.mockClear();

      for (let i = 0; i < 100; i++) {
        tracker.updateProgress('customers', 'replayProgress', {
          eventsProcessed: i,
        });
      }

      // Should have pushed at event count threshold
      expect(mockRes.write).toHaveBeenCalledOnce();
    });
  });

  describe('updateLastProjectedEventTimestamp', () => {
    test('updates the timestamp', () => {
      tracker.updateLastProjectedEventTimestamp('customers', 999);
      expect(tracker.getStatus('customers').lastProjectedEventTimestamp).toBe(
        999,
      );
    });

    test('does nothing for unknown read model', () => {
      tracker.updateLastProjectedEventTimestamp('nonexistent', 999);
      expect(tracker.getStatus('nonexistent')).toBeNull();
    });
  });

  describe('SSE client management', () => {
    test('addSseClient sends current status on connect', () => {
      const mockRes = { write: vi.fn() };
      tracker.addSseClient(mockRes);

      // Should have sent status for both RMs
      expect(mockRes.write).toHaveBeenCalledTimes(2);
    });

    test('removeSseClient stops receiving updates', () => {
      const mockRes = { write: vi.fn() };
      tracker.addSseClient(mockRes);
      mockRes.write.mockClear();

      tracker.removeSseClient(mockRes);
      tracker.setState('customers', 'live', 'corr-1');

      expect(mockRes.write).not.toHaveBeenCalled();
    });

    test('multiple clients receive updates', () => {
      const res1 = { write: vi.fn() };
      const res2 = { write: vi.fn() };
      tracker.addSseClient(res1);
      tracker.addSseClient(res2);
      res1.write.mockClear();
      res2.write.mockClear();

      tracker.setState('customers', 'replay', 'corr-1');

      expect(res1.write).toHaveBeenCalledOnce();
      expect(res2.write).toHaveBeenCalledOnce();
    });
  });

  describe('immediatePush', () => {
    test('pushes immediately and clears debounce state', () => {
      const mockRes = { write: vi.fn() };
      tracker.addSseClient(mockRes);
      mockRes.write.mockClear();

      // Start a debounced push
      tracker.updateProgress('customers', 'replayProgress', {
        eventsProcessed: 1,
      });
      expect(mockRes.write).not.toHaveBeenCalled();

      // Force immediate push
      tracker.immediatePush('customers');
      expect(mockRes.write).toHaveBeenCalledOnce();

      // Debounce timer should be cleared, no double push
      vi.advanceTimersByTime(200);
      expect(mockRes.write).toHaveBeenCalledOnce();
    });
  });

  describe('onStatusChange', () => {
    test('notifies listeners on state change', () => {
      const listener = vi.fn();
      tracker.onStatusChange(listener);

      tracker.setState('customers', 'replay', 'corr-1');

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          readModelName: 'customers',
          state: 'replay',
          correlationId: 'corr-1',
        }),
      );
    });

    test('notifies listeners on debounced push', () => {
      const listener = vi.fn();
      tracker.onStatusChange(listener);

      tracker.updateProgress('customers', 'replayProgress', {
        eventsProcessed: 50,
      });

      // Not called yet (debounced)
      expect(listener).not.toHaveBeenCalled();

      vi.advanceTimersByTime(100);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          readModelName: 'customers',
          replayProgress: { eventsProcessed: 50 },
        }),
      );
    });

    test('supports multiple listeners', () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      tracker.onStatusChange(listener1);
      tracker.onStatusChange(listener2);

      tracker.setState('orders', 'live');

      expect(listener1).toHaveBeenCalled();
      expect(listener2).toHaveBeenCalled();
    });

    test('provides a snapshot, not a reference', () => {
      const listener = vi.fn();
      tracker.onStatusChange(listener);

      tracker.setState('customers', 'replay');
      const snapshot = listener.mock.calls[0][0];

      tracker.setState('customers', 'idle');
      expect(snapshot.state).toBe('replay');
    });
  });
});
