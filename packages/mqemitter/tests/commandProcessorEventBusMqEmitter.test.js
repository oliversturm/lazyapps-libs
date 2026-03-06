import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockSpan, mockStartSpan } = vi.hoisted(() => {
  const mockSpan = { end: vi.fn() };
  const mockStartSpan = vi.fn(() => mockSpan);
  return { mockSpan, mockStartSpan };
});

vi.mock('@opentelemetry/api', () => ({
  trace: {
    getTracer: vi.fn(() => ({
      startSpan: mockStartSpan,
    })),
  },
}));

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockEmitter = vi.hoisted(() => ({
  emit: vi.fn(),
  on: vi.fn(),
}));

vi.mock('../mqEmitterRegistry.js', () => ({
  getSharedMqEmitter: vi.fn().mockReturnValue(mockEmitter),
}));

const { commandProcessorEventBusMqEmitter } =
  await import('../commandProcessorEventBusMqEmitter.js');

describe('commandProcessorEventBusMqEmitter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('factory returns publishEvent, publishReplayState, publishReplayEvent, and publishSystemMessage', () => {
    return commandProcessorEventBusMqEmitter({ mqName: 'test-mq' })().then(
      (bus) => {
        expect(bus).toHaveProperty('publishEvent');
        expect(bus).toHaveProperty('publishReplayState');
        expect(bus).toHaveProperty('publishReplayEvent');
        expect(bus).toHaveProperty('publishSystemMessage');
        expect(typeof bus.publishEvent).toBe('function');
        expect(typeof bus.publishReplayState).toBe('function');
        expect(typeof bus.publishReplayEvent).toBe('function');
        expect(typeof bus.publishSystemMessage).toBe('function');
      },
    );
  });

  test('publishEvent emits event to events topic', () => {
    return commandProcessorEventBusMqEmitter({ mqName: 'test-mq' })().then(
      (bus) => {
        const event = { timestamp: 12345, type: 'CREATED' };
        const result = bus.publishEvent('corr-1')(event);

        expect(mockEmitter.emit).toHaveBeenCalledWith({
          topic: 'events',
          payload: event,
        });
        expect(result).toBe(event);
      },
    );
  });

  test('publishEvent sets correlationId on event', () => {
    return commandProcessorEventBusMqEmitter({ mqName: 'test-mq' })().then(
      (bus) => {
        const event = { timestamp: 12345 };
        bus.publishEvent('corr-99')(event);

        expect(event.correlationId).toBe('corr-99');
      },
    );
  });

  test('publishReplayState emits to __system topic with correct format', () => {
    return commandProcessorEventBusMqEmitter({ mqName: 'test-mq' })().then(
      (bus) => {
        const result = bus.publishReplayState('corr-1')(true);

        expect(mockEmitter.emit).toHaveBeenCalledWith({
          topic: '__system',
          payload: {
            correlationId: 'corr-1',
            event: {
              type: 'SET_REPLAY_STATE',
              state: true,
            },
          },
        });
        expect(result).toBe(true);
      },
    );
  });

  test('publishReplayState with readModel includes readModel in event', () => {
    return commandProcessorEventBusMqEmitter({ mqName: 'test-mq' })().then(
      (bus) => {
        const result = bus.publishReplayState('corr-1')(true, 'items');

        expect(mockEmitter.emit).toHaveBeenCalledWith({
          topic: '__system',
          payload: {
            correlationId: 'corr-1',
            event: {
              type: 'SET_REPLAY_STATE',
              state: true,
              readModel: 'items',
            },
          },
        });
        expect(result).toBe(true);
      },
    );
  });

  test('publishReplayState returns the state value', () => {
    return commandProcessorEventBusMqEmitter({ mqName: 'test-mq' })().then(
      (bus) => {
        expect(bus.publishReplayState('corr-1')(false)).toBe(false);
      },
    );
  });

  test('publishReplayEvent emits on __replay topic with correct payload', () => {
    return commandProcessorEventBusMqEmitter({ mqName: 'test-mq' })().then(
      (bus) => {
        const event = { type: 'ITEM_CREATED', timestamp: 12345 };
        bus.publishReplayEvent('corr-1')('items', event);

        expect(mockEmitter.emit).toHaveBeenCalledWith({
          topic: '__replay',
          payload: {
            correlationId: 'corr-1',
            targetReadModel: 'items',
            event,
          },
        });
      },
    );
  });

  test('publishReplayEvent includes targetServiceId when provided', () => {
    return commandProcessorEventBusMqEmitter({ mqName: 'test-mq' })().then(
      (bus) => {
        const event = { type: 'ITEM_CREATED', timestamp: 12345 };
        bus.publishReplayEvent('corr-1')('items', event, 'orders-service');

        expect(mockEmitter.emit).toHaveBeenCalledWith({
          topic: '__replay',
          payload: {
            correlationId: 'corr-1',
            targetReadModel: 'items',
            event,
            targetServiceId: 'orders-service',
          },
        });
      },
    );
  });

  test('publishReplayEvent omits targetServiceId when not provided', () => {
    return commandProcessorEventBusMqEmitter({ mqName: 'test-mq' })().then(
      (bus) => {
        const event = { type: 'ITEM_CREATED', timestamp: 12345 };
        bus.publishReplayEvent('corr-1')('items', event);

        expect(mockEmitter.emit).toHaveBeenCalledWith({
          topic: '__replay',
          payload: {
            correlationId: 'corr-1',
            targetReadModel: 'items',
            event,
          },
        });
      },
    );
  });

  test('publishSystemMessage emits on __system topic with correct payload', () => {
    return commandProcessorEventBusMqEmitter({ mqName: 'test-mq' })().then(
      (bus) => {
        const message = { type: 'REPLAY_EVENTS_DONE', readModel: 'items' };
        bus.publishSystemMessage('corr-1')(message);

        expect(mockEmitter.emit).toHaveBeenCalledWith({
          topic: '__system',
          payload: {
            correlationId: 'corr-1',
            event: message,
          },
        });
      },
    );
  });
});

describe('mqemitter tracing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('publishEvent creates a span for event emission', () =>
    commandProcessorEventBusMqEmitter({ mqName: 'test-mq' })().then((bus) => {
      bus.publishEvent('corr-1')({ timestamp: 123, type: 'TEST' });
      expect(mockStartSpan).toHaveBeenCalledWith('lazyapps.mqemitter.emit', {
        attributes: { topic: 'events' },
      });
    }));

  test('publishEvent ends the span after emit', () =>
    commandProcessorEventBusMqEmitter({ mqName: 'test-mq' })().then((bus) => {
      bus.publishEvent('corr-1')({ timestamp: 123, type: 'TEST' });
      expect(mockSpan.end).toHaveBeenCalledOnce();
    }));

  test('span is ended after mq.emit is called', () =>
    commandProcessorEventBusMqEmitter({ mqName: 'test-mq' })().then((bus) => {
      const callOrder = [];
      mockEmitter.emit.mockImplementation(() => callOrder.push('emit'));
      mockSpan.end.mockImplementation(() => callOrder.push('end'));

      bus.publishEvent('corr-1')({ timestamp: 123, type: 'TEST' });
      expect(callOrder).toEqual(['emit', 'end']);
    }));
});
