import { describe, test, expect, vi } from 'vitest';
import { initializeContext } from '../context.js';

describe('initializeContext', () => {
  test('assembles context from config', () => {
    const aggregates = { thing: {} };
    const aggregateStoreResult = { name: 'aggregateStore' };
    const eventStoreResult = {
      name: 'eventStore',
    };
    const eventBusResult = { name: 'eventBus' };

    const aggregateStore = vi.fn().mockResolvedValue(aggregateStoreResult);
    const eventStore = vi.fn().mockResolvedValue(eventStoreResult);
    const eventBus = vi.fn().mockResolvedValue(eventBusResult);
    const handleCommand = vi.fn();
    const handleAdminCommand = vi.fn();

    return initializeContext(
      { serviceId: 'TEST' },
      { aggregateStore, eventStore, eventBus, aggregates },
      handleCommand,
      handleAdminCommand,
    ).then((context) => {
      expect(context.aggregates).toBe(aggregates);
      expect(context.aggregateStore).toBe(aggregateStoreResult);
      expect(context.eventStore).toBe(eventStoreResult);
      expect(context.eventBus).toBe(eventBusResult);
      expect(context.handleCommand).toBe(handleCommand);
      expect(context.handleAdminCommand).toBe(handleAdminCommand);
      expect(context.correlationConfig).toEqual({ serviceId: 'TEST' });
      expect(aggregateStore).toHaveBeenCalledWith(aggregates);
      expect(eventStore).toHaveBeenCalledOnce();
      expect(eventBus).toHaveBeenCalledOnce();
    });
  });
});
