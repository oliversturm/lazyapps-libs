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
      expect(context.eventBus).toBe(eventBusResult);
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
      publishSystemMessage: vi.fn(),
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
});
