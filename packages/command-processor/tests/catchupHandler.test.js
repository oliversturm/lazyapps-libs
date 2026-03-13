import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { createCatchupHandler } = await import('../catchupHandler.js');

describe('createCatchupHandler', () => {
  let eventStore;
  let eventBus;
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
      getLatestEventTimestamp: vi.fn().mockResolvedValue(1000),
      countEvents: vi.fn().mockResolvedValue(0),
      streamEvents: vi.fn().mockResolvedValue(makeCursor([])),
    };
    eventBus = {
      publishCatchupEvent: vi.fn().mockReturnValue(vi.fn()),
      publishSystemMessage: vi.fn().mockReturnValue(vi.fn()),
    };
    handler = createCatchupHandler(eventStore, eventBus);
  });

  describe('getCatchupStatus', () => {
    test('returns idle for unknown read model', () => {
      const status = handler.getCatchupStatus('items');
      expect(status).toEqual({ status: 'idle', readModel: 'items' });
    });
  });

  describe('startCatchup', () => {
    test('streams events from fromTimestamp to latest', () => {
      const events = [
        { type: 'ITEM_CREATED', timestamp: 100 },
        { type: 'ITEM_UPDATED', timestamp: 200 },
      ];
      const cursor = makeCursor(events);
      eventStore.getLatestEventTimestamp.mockResolvedValue(500);
      eventStore.countEvents.mockResolvedValue(2);
      eventStore.streamEvents.mockResolvedValue(cursor);

      const publishFn = vi.fn();
      eventBus.publishCatchupEvent.mockReturnValue(publishFn);

      return handler.startCatchup('corr-1', 'items', 50).then(() => {
        expect(eventStore.getLatestEventTimestamp).toHaveBeenCalled();
        expect(eventStore.countEvents).toHaveBeenCalledWith(50, 500);
        expect(eventStore.streamEvents).toHaveBeenCalledWith(50, 500);
      });
    });

    test('publishes events on __catchup topic', () => {
      const events = [
        { type: 'ITEM_CREATED', timestamp: 100 },
        { type: 'ITEM_UPDATED', timestamp: 200 },
      ];
      const cursor = makeCursor(events);
      eventStore.getLatestEventTimestamp.mockResolvedValue(500);
      eventStore.countEvents.mockResolvedValue(2);
      eventStore.streamEvents.mockResolvedValue(cursor);

      const publishFn = vi.fn();
      eventBus.publishCatchupEvent.mockReturnValue(publishFn);

      return handler.startCatchup('corr-1', 'items', 0).then(() => {
        expect(eventBus.publishCatchupEvent).toHaveBeenCalledWith('corr-1');
        expect(publishFn).toHaveBeenCalledTimes(2);
        expect(publishFn).toHaveBeenCalledWith('items', events[0], undefined);
        expect(publishFn).toHaveBeenCalledWith('items', events[1], undefined);
      });
    });

    test('publishes CATCHUP_EVENTS_DONE with toTimestamp after streaming', () => {
      const cursor = makeCursor([]);
      eventStore.getLatestEventTimestamp.mockResolvedValue(500);
      eventStore.countEvents.mockResolvedValue(0);
      eventStore.streamEvents.mockResolvedValue(cursor);

      const sysMsgFn = vi.fn();
      eventBus.publishSystemMessage.mockReturnValue(sysMsgFn);

      return handler.startCatchup('corr-1', 'items', 0).then(() => {
        expect(eventBus.publishSystemMessage).toHaveBeenCalledWith('corr-1');
        expect(sysMsgFn).toHaveBeenCalledWith({
          type: 'CATCHUP_EVENTS_DONE',
          readModel: 'items',
          toTimestamp: 500,
        });
      });
    });

    test('empty event store: immediate CATCHUP_EVENTS_DONE with toTimestamp 0', () => {
      eventStore.getLatestEventTimestamp.mockResolvedValue(null);

      const sysMsgFn = vi.fn();
      eventBus.publishSystemMessage.mockReturnValue(sysMsgFn);

      return handler.startCatchup('corr-1', 'items', 0).then(() => {
        expect(sysMsgFn).toHaveBeenCalledWith({
          type: 'CATCHUP_EVENTS_DONE',
          readModel: 'items',
          toTimestamp: 0,
        });
        expect(eventStore.countEvents).not.toHaveBeenCalled();
        expect(eventStore.streamEvents).not.toHaveBeenCalled();
      });
    });

    test('concurrent catch-up for same read model rejected', () => {
      const neverCursor = {
        next: vi.fn().mockReturnValue(new Promise(() => {})),
        close: vi.fn().mockResolvedValue(),
      };
      eventStore.getLatestEventTimestamp.mockResolvedValue(1000);
      eventStore.countEvents.mockResolvedValue(1000);
      eventStore.streamEvents.mockResolvedValue(neverCursor);

      handler.startCatchup('corr-1', 'items', 0);

      return handler.startCatchup('corr-2', 'items', 0).then(
        () => {
          throw new Error('should have rejected');
        },
        (err) => {
          expect(err.message).toMatch(/already in progress/);
        },
      );
    });

    test('allows catch-up for different read models concurrently', () => {
      const neverCursor = {
        next: vi.fn().mockReturnValue(new Promise(() => {})),
        close: vi.fn().mockResolvedValue(),
      };
      eventStore.getLatestEventTimestamp.mockResolvedValue(1000);
      eventStore.countEvents.mockResolvedValue(1000);
      eventStore.streamEvents.mockResolvedValue(neverCursor);

      handler.startCatchup('corr-1', 'items', 0);

      const cursor2 = makeCursor([]);
      eventStore.getLatestEventTimestamp.mockResolvedValue(500);
      eventStore.countEvents.mockResolvedValue(0);
      eventStore.streamEvents.mockResolvedValue(cursor2);
      eventBus.publishSystemMessage.mockReturnValue(vi.fn());

      return handler.startCatchup('corr-2', 'orders', 0).then(() => {
        expect(handler.getCatchupStatus('orders').status).toBe('completed');
      });
    });

    test('tracks eventsPublished and eventsTotal', () => {
      const events = [
        { type: 'A', timestamp: 1 },
        { type: 'B', timestamp: 2 },
        { type: 'C', timestamp: 3 },
      ];
      const cursor = makeCursor(events);
      eventStore.getLatestEventTimestamp.mockResolvedValue(100);
      eventStore.countEvents.mockResolvedValue(3);
      eventStore.streamEvents.mockResolvedValue(cursor);
      eventBus.publishCatchupEvent.mockReturnValue(vi.fn());
      eventBus.publishSystemMessage.mockReturnValue(vi.fn());

      return handler.startCatchup('corr-1', 'items', 0).then(() => {
        const status = handler.getCatchupStatus('items');
        expect(status.status).toBe('completed');
        expect(status.eventsPublished).toBe(3);
        expect(status.eventsTotal).toBe(3);
        expect(status.startedAt).toEqual(expect.any(Number));
        expect(status.cancel).toBeUndefined();
      });
    });

    test('terminal states preserve counters', () => {
      const events = [{ type: 'A', timestamp: 1 }];
      const cursor = makeCursor(events);
      eventStore.getLatestEventTimestamp.mockResolvedValue(100);
      eventStore.countEvents.mockResolvedValue(1);
      eventStore.streamEvents.mockResolvedValue(cursor);
      eventBus.publishCatchupEvent.mockReturnValue(vi.fn());
      eventBus.publishSystemMessage.mockReturnValue(vi.fn());

      return handler.startCatchup('corr-1', 'items', 0).then(() => {
        const status = handler.getCatchupStatus('items');
        expect(status.eventsPublished).toBe(1);
        expect(status.eventsTotal).toBe(1);
        expect(status.readModel).toBe('items');
      });
    });

    test('handles eventStore errors gracefully', () => {
      eventStore.getLatestEventTimestamp.mockRejectedValue(
        new Error('DB connection lost'),
      );

      const sysMsgFn = vi.fn();
      eventBus.publishSystemMessage.mockReturnValue(sysMsgFn);

      return handler.startCatchup('corr-1', 'items', 0).then(() => {
        const status = handler.getCatchupStatus('items');
        expect(status.status).toBe('error');
        expect(status.error).toMatch(/DB connection lost/);
        expect(sysMsgFn).toHaveBeenCalledWith({
          type: 'CATCHUP_CANCELLED',
          readModel: 'items',
        });
      });
    });

    test('handles cursor.next() errors gracefully', () => {
      eventStore.getLatestEventTimestamp.mockResolvedValue(100);
      eventStore.countEvents.mockResolvedValue(5);
      const errorCursor = {
        next: vi
          .fn()
          .mockResolvedValueOnce({ type: 'A', timestamp: 1 })
          .mockRejectedValueOnce(new Error('cursor error')),
        close: vi.fn().mockResolvedValue(),
      };
      eventStore.streamEvents.mockResolvedValue(errorCursor);
      eventBus.publishCatchupEvent.mockReturnValue(vi.fn());

      const sysMsgFn = vi.fn();
      eventBus.publishSystemMessage.mockReturnValue(sysMsgFn);

      return handler.startCatchup('corr-1', 'items', 0).then(() => {
        const status = handler.getCatchupStatus('items');
        expect(status.status).toBe('error');
        expect(sysMsgFn).toHaveBeenCalledWith({
          type: 'CATCHUP_CANCELLED',
          readModel: 'items',
        });
      });
    });
  });

  describe('cancelCatchup', () => {
    test('cancels an in-progress catch-up', () => {
      const neverCursor = {
        next: vi.fn().mockReturnValue(
          new Promise((resolve) => {
            // never resolves
          }),
        ),
        close: vi.fn().mockResolvedValue(),
      };
      eventStore.getLatestEventTimestamp.mockResolvedValue(1000);
      eventStore.countEvents.mockResolvedValue(1000);
      eventStore.streamEvents.mockResolvedValue(neverCursor);

      const sysMsgFn = vi.fn();
      eventBus.publishSystemMessage.mockReturnValue(sysMsgFn);

      handler.startCatchup('corr-1', 'items', 0);

      return Promise.resolve()
        .then(() => Promise.resolve())
        .then(() => Promise.resolve())
        .then(() => Promise.resolve())
        .then(() => handler.cancelCatchup('corr-1', 'items'))
        .then(() => {
          expect(neverCursor.close).toHaveBeenCalled();
        });
    });

    test('is no-op when no catch-up in progress', () => {
      return handler.cancelCatchup('corr-1', 'items').then((result) => {
        expect(result).toBeUndefined();
      });
    });

    test('is no-op when catch-up already completed', () => {
      eventStore.getLatestEventTimestamp.mockResolvedValue(100);
      const cursor = makeCursor([]);
      eventStore.countEvents.mockResolvedValue(0);
      eventStore.streamEvents.mockResolvedValue(cursor);
      eventBus.publishSystemMessage.mockReturnValue(vi.fn());

      return handler
        .startCatchup('corr-1', 'items', 0)
        .then(() => handler.cancelCatchup('corr-2', 'items'))
        .then((result) => {
          expect(result).toBeUndefined();
          expect(handler.getCatchupStatus('items').status).toBe('completed');
        });
    });
  });
});
