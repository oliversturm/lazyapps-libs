import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  }),
}));

const { createCpStatusTracker } = await import('../cpStatusTracker.js');

describe('createCpStatusTracker', () => {
  let tracker;

  beforeEach(() => {
    vi.useFakeTimers();
    tracker = createCpStatusTracker();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('getStatus', () => {
    test('returns live status with empty arrays when no operations active', () => {
      const status = tracker.getStatus();
      // The CP is always live — "idle" (no active replay/catch-up) is not a
      // not-running state (issue #15).
      expect(status).toMatchObject({
        state: 'live',
        activeReplays: [],
        activeCatchUps: [],
      });
    });

    test('returns replaying state when replays are active', () => {
      tracker.trackReplayStart('customers', 'ep1', 'corr-1');
      const status = tracker.getStatus();
      expect(status.state).toBe('replaying');
      expect(status.activeReplays).toHaveLength(1);
      expect(status.activeReplays[0]).toEqual({
        readModel: 'customers',
        targetEndpointName: 'ep1',
        eventsSent: 0,
        lastSentTimestamp: 0,
        correlationId: 'corr-1',
      });
    });

    test('returns catching-up state when only catch-ups are active', () => {
      tracker.trackCatchUpStart('orders', 'ep2', 'corr-2');
      const status = tracker.getStatus();
      expect(status.state).toBe('catching-up');
      expect(status.activeCatchUps).toHaveLength(1);
      expect(status.activeCatchUps[0]).toEqual({
        readModel: 'orders',
        targetEndpointName: 'ep2',
        eventsSent: 0,
        lastSentTimestamp: 0,
        correlationId: 'corr-2',
      });
    });

    test('replaying takes precedence over catching-up', () => {
      tracker.trackReplayStart('customers', 'ep1', 'corr-1');
      tracker.trackCatchUpStart('orders', 'ep2', 'corr-2');
      const status = tracker.getStatus();
      expect(status.state).toBe('replaying');
      expect(status.activeReplays).toHaveLength(1);
      expect(status.activeCatchUps).toHaveLength(1);
    });

    test('returns live after all operations end', () => {
      tracker.trackReplayStart('customers', 'ep1', 'corr-1');
      tracker.trackReplayEnd('customers', 'ep1');
      const status = tracker.getStatus();
      expect(status.state).toBe('live');
      expect(status.activeReplays).toHaveLength(0);
    });
  });

  describe('live detail (issue #15 B)', () => {
    test('initial status exposes zeroed counters and empty history', () => {
      const status = tracker.getStatus();
      expect(typeof status.startedAt).toBe('number');
      expect(status.commandsProcessed).toBe(0);
      expect(status.eventsWritten).toBe(0);
      expect(status.lastCommandAt).toBeNull();
      expect(status.lastEventTimestamp).toBeNull();
      expect(status.recentReplays).toEqual([]);
    });

    test('trackLiveEvent bumps counters and records timestamps', () => {
      vi.setSystemTime(5_000);
      tracker.trackLiveEvent(4_200);
      const status = tracker.getStatus();
      expect(status.commandsProcessed).toBe(1);
      expect(status.eventsWritten).toBe(1);
      expect(status.lastCommandAt).toBe(5_000);
      expect(status.lastEventTimestamp).toBe(4_200);
    });

    test('trackLiveEvent accumulates across calls', () => {
      tracker.trackLiveEvent(1);
      tracker.trackLiveEvent(2);
      tracker.trackLiveEvent(3);
      const status = tracker.getStatus();
      expect(status.commandsProcessed).toBe(3);
      expect(status.eventsWritten).toBe(3);
      expect(status.lastEventTimestamp).toBe(3);
    });

    test('trackLiveEvent schedules a debounced SSE push', () => {
      const mockRes = { write: vi.fn() };
      tracker.addSseClient(mockRes);
      mockRes.write.mockClear();

      tracker.trackLiveEvent(100);
      expect(mockRes.write).not.toHaveBeenCalled();
      vi.advanceTimersByTime(100);
      expect(mockRes.write).toHaveBeenCalledTimes(1);
      const data = JSON.parse(
        mockRes.write.mock.calls[0][0].split('data: ')[1].split('\n')[0],
      );
      expect(data.eventsWritten).toBe(1);
    });

    test('trackReplayEnd records a completed-replay summary', () => {
      vi.setSystemTime(9_000);
      tracker.trackReplayStart('customers', 'ep1', 'corr-1');
      tracker.trackReplayEvent('customers', 'ep1', 1000);
      tracker.trackReplayEvent('customers', 'ep1', 2000);
      tracker.trackReplayEnd('customers', 'ep1');

      const { recentReplays } = tracker.getStatus();
      expect(recentReplays).toHaveLength(1);
      expect(recentReplays[0]).toEqual({
        readModel: 'customers',
        targetEndpointName: 'ep1',
        eventsSent: 2,
        completedAt: 9_000,
      });
    });

    test('recentReplays keeps only the last 5, most recent first', () => {
      for (let i = 1; i <= 7; i++) {
        tracker.trackReplayStart(`rm${i}`, 'ep1', `corr-${i}`);
        tracker.trackReplayEnd(`rm${i}`, 'ep1');
      }
      const { recentReplays } = tracker.getStatus();
      expect(recentReplays).toHaveLength(5);
      expect(recentReplays.map((r) => r.readModel)).toEqual([
        'rm7',
        'rm6',
        'rm5',
        'rm4',
        'rm3',
      ]);
    });
  });

  describe('replay tracking', () => {
    test('trackReplayEvent updates eventsSent and lastSentTimestamp', () => {
      tracker.trackReplayStart('customers', 'ep1', 'corr-1');
      tracker.trackReplayEvent('customers', 'ep1', 1000);
      tracker.trackReplayEvent('customers', 'ep1', 2000);
      const status = tracker.getStatus();
      expect(status.activeReplays[0].eventsSent).toBe(2);
      expect(status.activeReplays[0].lastSentTimestamp).toBe(2000);
    });

    test('supports multiple concurrent replays', () => {
      tracker.trackReplayStart('customers', 'ep1', 'corr-1');
      tracker.trackReplayStart('orders', 'ep2', 'corr-2');
      const status = tracker.getStatus();
      expect(status.activeReplays).toHaveLength(2);
    });
  });

  describe('catch-up tracking', () => {
    test('trackCatchUpEvent updates eventsSent and lastSentTimestamp', () => {
      tracker.trackCatchUpStart('orders', 'ep2', 'corr-2');
      tracker.trackCatchUpEvent('orders', 'ep2', 500);
      const status = tracker.getStatus();
      expect(status.activeCatchUps[0].eventsSent).toBe(1);
      expect(status.activeCatchUps[0].lastSentTimestamp).toBe(500);
    });

    test('trackCatchUpSetToTimestamp includes toTimestamp in status', () => {
      tracker.trackCatchUpStart('orders', 'ep2', 'corr-2');
      tracker.trackCatchUpSetToTimestamp('orders', 'ep2', 9999);
      const status = tracker.getStatus();
      expect(status.activeCatchUps[0].toTimestamp).toBe(9999);
    });
  });

  describe('SSE push', () => {
    test('sends current status snapshot to a newly connected SSE client', () => {
      tracker.trackReplayStart('customers', 'ep1', 'corr-1');

      const mockRes = { write: vi.fn() };
      tracker.addSseClient(mockRes);

      expect(mockRes.write).toHaveBeenCalled();
      const written = mockRes.write.mock.calls.find((c) =>
        c[0].includes('status-change'),
      );
      expect(written).toBeDefined();
      const data = JSON.parse(written[0].split('data: ')[1].split('\n')[0]);
      expect(data.state).toBe('replaying');
      expect(data.activeReplays).toHaveLength(1);
    });

    test('pushes status to SSE clients on replay start', () => {
      const mockRes = { write: vi.fn() };
      tracker.addSseClient(mockRes);
      mockRes.write.mockClear();
      tracker.trackReplayStart('customers', 'ep1', 'corr-1');
      expect(mockRes.write).toHaveBeenCalled();
      const written = mockRes.write.mock.calls.find((c) =>
        c[0].includes('status-change'),
      );
      expect(written).toBeDefined();
      const data = JSON.parse(written[0].split('data: ')[1].split('\n')[0]);
      expect(data.state).toBe('replaying');
    });

    test('pushes status to SSE clients on replay end', () => {
      const mockRes = { write: vi.fn() };
      tracker.addSseClient(mockRes);
      tracker.trackReplayStart('customers', 'ep1', 'corr-1');
      mockRes.write.mockClear();
      tracker.trackReplayEnd('customers', 'ep1');
      expect(mockRes.write).toHaveBeenCalled();
      const written = mockRes.write.mock.calls.find((c) =>
        c[0].includes('status-change'),
      );
      const data = JSON.parse(written[0].split('data: ')[1].split('\n')[0]);
      expect(data.state).toBe('live');
    });

    test('debounces event pushes — max 1 per 100ms', () => {
      const mockRes = { write: vi.fn() };
      tracker.addSseClient(mockRes);
      tracker.trackReplayStart('customers', 'ep1', 'corr-1');
      mockRes.write.mockClear();

      tracker.trackReplayEvent('customers', 'ep1', 100);
      tracker.trackReplayEvent('customers', 'ep1', 200);
      tracker.trackReplayEvent('customers', 'ep1', 300);

      // No push yet (debounced)
      expect(mockRes.write).not.toHaveBeenCalled();

      vi.advanceTimersByTime(100);
      expect(mockRes.write).toHaveBeenCalledTimes(1);
    });

    test('debounces event pushes — max 1 per 100 events', () => {
      const mockRes = { write: vi.fn() };
      tracker.addSseClient(mockRes);
      tracker.trackReplayStart('customers', 'ep1', 'corr-1');
      mockRes.write.mockClear();

      for (let i = 0; i < 100; i++) {
        tracker.trackReplayEvent('customers', 'ep1', i);
      }

      // 100th event triggers immediate push
      expect(mockRes.write).toHaveBeenCalledTimes(1);
    });

    test('removes SSE client on removeSseClient', () => {
      const mockRes = { write: vi.fn() };
      tracker.addSseClient(mockRes);
      mockRes.write.mockClear();
      tracker.removeSseClient(mockRes);
      tracker.trackReplayStart('customers', 'ep1', 'corr-1');
      expect(mockRes.write).not.toHaveBeenCalled();
    });
  });
});
