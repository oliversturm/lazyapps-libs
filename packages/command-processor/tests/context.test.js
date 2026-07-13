import { describe, test, expect, vi } from 'vitest';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  }),
}));

const { initializeContext } = await import('../context.js');

describe('initializeContext', () => {
  test('assembles context from config', () => {
    const aggregates = { thing: {} };
    const aggregateStoreResult = { name: 'aggregateStore' };
    const eventStoreResult = {
      name: 'eventStore',
      replay: vi.fn().mockReturnValue(vi.fn().mockResolvedValue()),
    };
    const eventBusResult = { name: 'eventBus' };

    const aggregateStore = vi.fn().mockResolvedValue(aggregateStoreResult);
    const eventStore = vi.fn().mockResolvedValue(eventStoreResult);
    const eventBus = vi.fn().mockResolvedValue(eventBusResult);
    const handleCommand = vi.fn();

    return initializeContext(
      { serviceId: 'TEST' },
      { aggregateStore, eventStore, eventBus, aggregates },
      handleCommand,
    ).then((context) => {
      expect(context.aggregates).toBe(aggregates);
      expect(context.aggregateStore).toBe(aggregateStoreResult);
      expect(context.eventStore).toBe(eventStoreResult);
      // eventBus is wrapped (publishEvent instrumented for live counters), so
      // it is a new object that preserves the adapter's other properties.
      expect(context.eventBus.name).toBe('eventBus');
      expect(typeof context.eventBus.publishEvent).toBe('function');
      expect(context.handleCommand).toBe(handleCommand);
      expect(context.correlationConfig).toEqual({ serviceId: 'TEST' });
      expect(aggregateStore).toHaveBeenCalledWith(aggregates);
      expect(eventStore).toHaveBeenCalledOnce();
      expect(eventBus).toHaveBeenCalledOnce();
      expect(eventStoreResult.replay).toHaveBeenCalledWith('INIT');
    });
  });

  test('wires replayHandler into context', () => {
    const aggregates = { thing: {} };
    const aggregateStoreResult = { name: 'aggregateStore' };
    const eventStoreResult = {
      name: 'eventStore',
      replay: vi.fn().mockReturnValue(vi.fn().mockResolvedValue()),
      countEvents: vi.fn(),
      streamEvents: vi.fn(),
    };
    const eventBusResult = {
      name: 'eventBus',
      publishReplayEvent: vi.fn(),
    };

    const aggregateStore = vi.fn().mockResolvedValue(aggregateStoreResult);
    const eventStore = vi.fn().mockResolvedValue(eventStoreResult);
    const eventBus = vi.fn().mockResolvedValue(eventBusResult);

    return initializeContext(
      { serviceId: 'TEST' },
      { aggregateStore, eventStore, eventBus, aggregates },
      vi.fn(),
    ).then((context) => {
      expect(context.replayHandler).toBeDefined();
      expect(typeof context.replayHandler.startReplay).toBe('function');
      expect(typeof context.replayHandler.cancelReplay).toBe('function');
      expect(typeof context.replayHandler.getReplayStatus).toBe('function');
    });
  });

  test('wires statusTracker into context', () => {
    const aggregates = { thing: {} };
    const aggregateStoreResult = { name: 'aggregateStore' };
    const eventStoreResult = {
      name: 'eventStore',
      replay: vi.fn().mockReturnValue(vi.fn().mockResolvedValue()),
    };
    const eventBusResult = { name: 'eventBus' };

    const aggregateStore = vi.fn().mockResolvedValue(aggregateStoreResult);
    const eventStore = vi.fn().mockResolvedValue(eventStoreResult);
    const eventBus = vi.fn().mockResolvedValue(eventBusResult);

    return initializeContext(
      { serviceId: 'TEST' },
      { aggregateStore, eventStore, eventBus, aggregates },
      vi.fn(),
    ).then((context) => {
      expect(context.statusTracker).toBeDefined();
      expect(typeof context.statusTracker.getStatus).toBe('function');
      expect(typeof context.statusTracker.addSseClient).toBe('function');
      expect(typeof context.statusTracker.removeSseClient).toBe('function');
    });
  });

  test('wraps publishEvent to advance live counters and delegate (issue #15)', () => {
    const aggregates = { thing: {} };
    const eventStoreResult = {
      name: 'eventStore',
      replay: vi.fn().mockReturnValue(vi.fn().mockResolvedValue()),
    };
    const innerPublish = vi.fn((event) => event);
    const eventBusResult = {
      name: 'eventBus',
      publishEvent: vi.fn().mockReturnValue(innerPublish),
    };

    const aggregateStore = vi
      .fn()
      .mockResolvedValue({ name: 'aggregateStore' });
    const eventStore = vi.fn().mockResolvedValue(eventStoreResult);
    const eventBus = vi.fn().mockResolvedValue(eventBusResult);

    return initializeContext(
      { serviceId: 'TEST' },
      { aggregateStore, eventStore, eventBus, aggregates },
      vi.fn(),
    ).then((context) => {
      const event = { type: 'X', timestamp: 4321 };
      const result = context.eventBus.publishEvent('corr-1')(event);

      // Delegates to the underlying adapter and returns its result
      expect(eventBusResult.publishEvent).toHaveBeenCalledWith('corr-1');
      expect(innerPublish).toHaveBeenCalledWith(event);
      expect(result).toBe(event);

      // Advances the live counters on the status tracker
      const status = context.statusTracker.getStatus();
      expect(status.commandsProcessed).toBe(1);
      expect(status.eventsWritten).toBe(1);
      expect(status.lastEventTimestamp).toBe(4321);
    });
  });

  test('does not have isReady or setReady (deferReady eliminated)', () => {
    const aggregates = { thing: {} };
    const aggregateStoreResult = { name: 'aggregateStore' };
    const eventStoreResult = {
      name: 'eventStore',
      replay: vi.fn().mockReturnValue(vi.fn().mockResolvedValue()),
    };
    const eventBusResult = { name: 'eventBus' };

    const aggregateStore = vi.fn().mockResolvedValue(aggregateStoreResult);
    const eventStore = vi.fn().mockResolvedValue(eventStoreResult);
    const eventBus = vi.fn().mockResolvedValue(eventBusResult);

    return initializeContext(
      { serviceId: 'TEST' },
      { aggregateStore, eventStore, eventBus, aggregates },
      vi.fn(),
    ).then((context) => {
      expect(context.isReady).toBeUndefined();
      expect(context.setReady).toBeUndefined();
    });
  });

  test('subscribes to admin messages with camelCase commands', () => {
    const aggregates = { thing: {} };
    const aggregateStoreResult = { name: 'aggregateStore' };
    const eventStoreResult = {
      name: 'eventStore',
      replay: vi.fn().mockReturnValue(vi.fn().mockResolvedValue()),
      countEvents: vi.fn().mockResolvedValue(0),
      streamEvents: vi.fn().mockResolvedValue({
        next: vi.fn().mockResolvedValue(null),
        close: vi.fn(),
      }),
      getLatestEventTimestamp: vi.fn().mockResolvedValue(null),
    };

    let subscribedHandler;
    const eventBusResult = {
      name: 'eventBus',
      publishReplayEvent: vi.fn().mockReturnValue(vi.fn()),
      publishCatchupEvent: vi.fn().mockReturnValue(vi.fn()),
      subscribeAdminMessages: vi.fn((handler) => {
        subscribedHandler = handler;
      }),
    };

    const aggregateStore = vi.fn().mockResolvedValue(aggregateStoreResult);
    const eventStore = vi.fn().mockResolvedValue(eventStoreResult);
    const eventBus = vi.fn().mockResolvedValue(eventBusResult);

    return initializeContext(
      { serviceId: 'TEST' },
      { aggregateStore, eventStore, eventBus, aggregates },
      vi.fn(),
    ).then(() => {
      expect(eventBusResult.subscribeAdminMessages).toHaveBeenCalled();
      expect(subscribedHandler).toBeDefined();

      // Verify 'replay' command (was 'start_replay')
      eventStoreResult.countEvents.mockResolvedValue(0);
      eventStoreResult.streamEvents.mockResolvedValue({
        next: vi.fn().mockResolvedValue(null),
        close: vi.fn(),
      });
      subscribedHandler('corr-1', {
        type: 'replay',
        readModel: 'items',
        fromTimestamp: 0,
        targetEndpointName: 'ep1',
        replayRelevantEvents: ['A', 'B'],
      });

      // Verify 'cancelReplay' command (was 'cancel_replay')
      subscribedHandler('corr-2', {
        type: 'cancelReplay',
        readModel: 'items',
      });

      // Verify 'startCatchup' command (was 'start_catchup')
      eventStoreResult.countEvents.mockResolvedValue(0);
      subscribedHandler('corr-3', {
        type: 'startCatchup',
        readModel: 'orders',
        fromTimestamp: 100,
        targetEndpointName: 'ep2',
        replayRelevantEvents: ['C'],
      });

      // Verify 'cancelCatchup' command (was 'cancel_catchup')
      subscribedHandler('corr-4', {
        type: 'cancelCatchup',
        readModel: 'orders',
      });

      // Verify 'set_ready' is NOT handled (eliminated)
      // This should go to the default case without error
      subscribedHandler('corr-5', { type: 'set_ready' });
    });
  });
});
