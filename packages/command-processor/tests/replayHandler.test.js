import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  }),
}));

const { createReplayHandler } = await import('../replayHandler.js');

describe('createReplayHandler', () => {
  let eventStore;
  let eventBus;
  let statusTracker;
  let handler;

  const makeCursor = (events) => {
    let index = 0;
    return {
      next: vi.fn(() => Promise.resolve(events[index++] || null)),
      close: vi.fn().mockResolvedValue(),
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    eventStore = {
      countEvents: vi.fn().mockResolvedValue(0),
      streamEvents: vi.fn().mockResolvedValue(makeCursor([])),
    };
    eventBus = {
      publishReplayEvent: vi.fn().mockReturnValue(vi.fn()),
    };
    statusTracker = {
      trackReplayStart: vi.fn(),
      trackReplayEvent: vi.fn(),
      trackReplayEnd: vi.fn(),
    };
    handler = createReplayHandler(eventStore, eventBus, statusTracker);
  });

  describe('getReplayStatus', () => {
    test('returns idle for unknown read model', () => {
      const status = handler.getReplayStatus('items');
      expect(status).toEqual({ status: 'idle', readModel: 'items' });
    });
  });

  describe('startReplay', () => {
    test('streams events and publishes them on __replay', () => {
      const events = [
        { type: 'ITEM_CREATED', timestamp: 100 },
        { type: 'ITEM_UPDATED', timestamp: 200 },
      ];
      const cursor = makeCursor(events);
      eventStore.countEvents.mockResolvedValue(2);
      eventStore.streamEvents.mockResolvedValue(cursor);

      const publishFn = vi.fn();
      eventBus.publishReplayEvent.mockReturnValue(publishFn);

      return handler.startReplay('corr-1', 'items', 0, null).then(() => {
        expect(eventStore.countEvents).toHaveBeenCalledWith(0, null);
        expect(eventStore.streamEvents).toHaveBeenCalledWith(0, null);
        expect(eventBus.publishReplayEvent).toHaveBeenCalledWith('corr-1');
        expect(publishFn).toHaveBeenCalledTimes(2);
        expect(publishFn).toHaveBeenCalledWith('items', events[0], undefined);
        expect(publishFn).toHaveBeenCalledWith('items', events[1], undefined);
      });
    });

    test('sets status to completed after successful replay', () => {
      const cursor = makeCursor([]);
      eventStore.countEvents.mockResolvedValue(0);
      eventStore.streamEvents.mockResolvedValue(cursor);

      return handler.startReplay('corr-1', 'items', 0, null).then(() => {
        const status = handler.getReplayStatus('items');
        expect(status.status).toBe('completed');
        expect(status.readModel).toBe('items');
      });
    });

    test('tracks eventsPublished and eventsTotal', () => {
      const events = [
        { type: 'A', timestamp: 1 },
        { type: 'B', timestamp: 2 },
        { type: 'C', timestamp: 3 },
      ];
      const cursor = makeCursor(events);
      eventStore.countEvents.mockResolvedValue(3);
      eventStore.streamEvents.mockResolvedValue(cursor);
      eventBus.publishReplayEvent.mockReturnValue(vi.fn());

      return handler.startReplay('corr-1', 'items', 0, null).then(() => {
        const status = handler.getReplayStatus('items');
        expect(status.status).toBe('completed');
        expect(status.readModel).toBe('items');
        expect(status.eventsPublished).toBe(3);
        expect(status.eventsTotal).toBe(3);
        expect(status.startedAt).toEqual(expect.any(Number));
        expect(status.cancel).toBeUndefined();
      });
    });

    test('rejects if replay already in progress for same read model', () => {
      // Start a replay that never finishes (cursor.next never resolves)
      const neverCursor = {
        next: vi.fn().mockReturnValue(new Promise(() => {})),
        close: vi.fn().mockResolvedValue(),
      };
      eventStore.countEvents.mockResolvedValue(1000);
      eventStore.streamEvents.mockResolvedValue(neverCursor);

      handler.startReplay('corr-1', 'items', 0, null);

      return handler.startReplay('corr-2', 'items', 0, null).then(
        () => {
          throw new Error('should have rejected');
        },
        (err) => {
          expect(err.message).toMatch(/already in progress/);
        },
      );
    });

    test('allows replay for different read models concurrently', () => {
      const neverCursor = {
        next: vi.fn().mockReturnValue(new Promise(() => {})),
        close: vi.fn().mockResolvedValue(),
      };
      eventStore.countEvents.mockResolvedValue(1000);
      eventStore.streamEvents.mockResolvedValue(neverCursor);

      handler.startReplay('corr-1', 'items', 0, null);

      // Should not reject for a different read model
      const cursor2 = makeCursor([]);
      eventStore.countEvents.mockResolvedValue(0);
      eventStore.streamEvents.mockResolvedValue(cursor2);

      return handler.startReplay('corr-2', 'orders', 0, null).then(() => {
        expect(handler.getReplayStatus('orders').status).toBe('completed');
      });
    });

    test('handles eventStore errors gracefully', () => {
      eventStore.countEvents.mockRejectedValue(new Error('DB connection lost'));

      return handler.startReplay('corr-1', 'items', 0, null).then(() => {
        const status = handler.getReplayStatus('items');
        expect(status.status).toBe('error');
        expect(status.error).toMatch(/DB connection lost/);
      });
    });

    test('handles cursor.next() errors gracefully', () => {
      eventStore.countEvents.mockResolvedValue(5);
      const errorCursor = {
        next: vi
          .fn()
          .mockResolvedValueOnce({ type: 'A', timestamp: 1 })
          .mockRejectedValueOnce(new Error('cursor error')),
        close: vi.fn().mockResolvedValue(),
      };
      eventStore.streamEvents.mockResolvedValue(errorCursor);
      eventBus.publishReplayEvent.mockReturnValue(vi.fn());

      return handler.startReplay('corr-1', 'items', 0, null).then(() => {
        const status = handler.getReplayStatus('items');
        expect(status.status).toBe('error');
      });
    });

    test('passes targetEndpointName to publishReplayEvent when provided', () => {
      const events = [{ type: 'ITEM_CREATED', timestamp: 100 }];
      const cursor = makeCursor(events);
      eventStore.countEvents.mockResolvedValue(1);
      eventStore.streamEvents.mockResolvedValue(cursor);

      const publishFn = vi.fn();
      eventBus.publishReplayEvent.mockReturnValue(publishFn);

      return handler
        .startReplay('corr-1', 'items', 0, null, 'orders-service')
        .then(() => {
          expect(publishFn).toHaveBeenCalledWith(
            'items',
            events[0],
            'orders-service',
          );
        });
    });

    test('passes fromTimestamp and toTimestamp to eventStore', () => {
      const cursor = makeCursor([]);
      eventStore.countEvents.mockResolvedValue(0);
      eventStore.streamEvents.mockResolvedValue(cursor);

      return handler.startReplay('corr-1', 'items', 500, 1000).then(() => {
        expect(eventStore.countEvents).toHaveBeenCalledWith(500, 1000);
        expect(eventStore.streamEvents).toHaveBeenCalledWith(500, 1000);
      });
    });

    test('filters events by replayRelevantEvents', () => {
      const events = [
        { type: 'ITEM_CREATED', timestamp: 100 },
        { type: 'OTHER_EVENT', timestamp: 200 },
        { type: 'ITEM_UPDATED', timestamp: 300 },
      ];
      const cursor = makeCursor(events);
      eventStore.countEvents.mockResolvedValue(3);
      eventStore.streamEvents.mockResolvedValue(cursor);

      const publishFn = vi.fn();
      eventBus.publishReplayEvent.mockReturnValue(publishFn);

      return handler
        .startReplay('corr-1', 'items', 0, null, undefined, [
          'ITEM_CREATED',
          'ITEM_UPDATED',
        ])
        .then(() => {
          expect(publishFn).toHaveBeenCalledTimes(2);
          expect(publishFn).toHaveBeenCalledWith('items', events[0], undefined);
          expect(publishFn).toHaveBeenCalledWith('items', events[2], undefined);
        });
    });

    test('publishes all events when replayRelevantEvents is empty', () => {
      const events = [
        { type: 'ITEM_CREATED', timestamp: 100 },
        { type: 'OTHER_EVENT', timestamp: 200 },
      ];
      const cursor = makeCursor(events);
      eventStore.countEvents.mockResolvedValue(2);
      eventStore.streamEvents.mockResolvedValue(cursor);

      const publishFn = vi.fn();
      eventBus.publishReplayEvent.mockReturnValue(publishFn);

      return handler
        .startReplay('corr-1', 'items', 0, null, undefined, [])
        .then(() => {
          expect(publishFn).toHaveBeenCalledTimes(2);
        });
    });

    test('publishes all events when replayRelevantEvents is not provided', () => {
      const events = [
        { type: 'ITEM_CREATED', timestamp: 100 },
        { type: 'OTHER_EVENT', timestamp: 200 },
      ];
      const cursor = makeCursor(events);
      eventStore.countEvents.mockResolvedValue(2);
      eventStore.streamEvents.mockResolvedValue(cursor);

      const publishFn = vi.fn();
      eventBus.publishReplayEvent.mockReturnValue(publishFn);

      return handler.startReplay('corr-1', 'items', 0, null).then(() => {
        expect(publishFn).toHaveBeenCalledTimes(2);
      });
    });

    test('notifies statusTracker on replay lifecycle', () => {
      const cursor = makeCursor([{ type: 'A', timestamp: 100 }]);
      eventStore.countEvents.mockResolvedValue(1);
      eventStore.streamEvents.mockResolvedValue(cursor);
      eventBus.publishReplayEvent.mockReturnValue(vi.fn());

      return handler.startReplay('corr-1', 'items', 0, null, 'ep1').then(() => {
        expect(statusTracker.trackReplayStart).toHaveBeenCalledWith(
          'items',
          'ep1',
          'corr-1',
        );
        expect(statusTracker.trackReplayEvent).toHaveBeenCalledWith(
          'items',
          'ep1',
          100,
        );
        expect(statusTracker.trackReplayEnd).toHaveBeenCalledWith(
          'items',
          'ep1',
        );
      });
    });

    test('notifies statusTracker on error', () => {
      eventStore.countEvents.mockRejectedValue(new Error('DB error'));

      return handler.startReplay('corr-1', 'items', 0, null, 'ep1').then(() => {
        expect(statusTracker.trackReplayEnd).toHaveBeenCalledWith(
          'items',
          'ep1',
        );
      });
    });

    test('works without statusTracker (backward compat)', () => {
      const handlerNoTracker = createReplayHandler(eventStore, eventBus);
      const cursor = makeCursor([]);
      eventStore.countEvents.mockResolvedValue(0);
      eventStore.streamEvents.mockResolvedValue(cursor);

      return handlerNoTracker
        .startReplay('corr-1', 'items', 0, null)
        .then(() => {
          expect(handlerNoTracker.getReplayStatus('items').status).toBe(
            'completed',
          );
        });
    });
  });

  describe('cancelReplay', () => {
    test('cancels an in-progress replay', () => {
      const neverCursor = {
        next: vi.fn().mockReturnValue(
          new Promise(() => {
            // never resolves — replay stays in progress until cancelled
          }),
        ),
        close: vi.fn().mockResolvedValue(),
      };
      eventStore.countEvents.mockResolvedValue(1000);
      eventStore.streamEvents.mockResolvedValue(neverCursor);

      handler.startReplay('corr-1', 'items', 0, null);

      // Wait for microtasks so activeCursor gets set
      return Promise.resolve()
        .then(() => Promise.resolve())
        .then(() => handler.cancelReplay('corr-1', 'items'))
        .then(() => {
          expect(neverCursor.close).toHaveBeenCalled();
        });
    });

    test('is no-op when no replay in progress', () => {
      return handler.cancelReplay('corr-1', 'items').then((result) => {
        expect(result).toBeUndefined();
      });
    });

    test('is no-op when replay already completed', () => {
      const cursor = makeCursor([]);
      eventStore.countEvents.mockResolvedValue(0);
      eventStore.streamEvents.mockResolvedValue(cursor);

      return handler
        .startReplay('corr-1', 'items', 0, null)
        .then(() => handler.cancelReplay('corr-2', 'items'))
        .then((result) => {
          expect(result).toBeUndefined();
          // Status should still be completed, not cancelled
          expect(handler.getReplayStatus('items').status).toBe('completed');
        });
    });
  });
});
