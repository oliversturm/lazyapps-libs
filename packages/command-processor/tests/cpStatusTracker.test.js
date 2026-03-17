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
    test('returns idle status with empty arrays when no operations active', () => {
      const status = tracker.getStatus();
      expect(status).toEqual({
        state: 'idle',
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

    test('returns idle after all operations end', () => {
      tracker.trackReplayStart('customers', 'ep1', 'corr-1');
      tracker.trackReplayEnd('customers', 'ep1');
      const status = tracker.getStatus();
      expect(status.state).toBe('idle');
      expect(status.activeReplays).toHaveLength(0);
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
    test('pushes status to SSE clients on replay start', () => {
      const mockRes = { write: vi.fn() };
      tracker.addSseClient(mockRes);
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
      expect(data.state).toBe('idle');
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
      tracker.removeSseClient(mockRes);
      tracker.trackReplayStart('customers', 'ep1', 'corr-1');
      expect(mockRes.write).not.toHaveBeenCalled();
    });
  });
});
