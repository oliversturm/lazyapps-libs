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

  test('factory returns publishEvent, publishReplayEvent, publishCatchupEvent, and publishAdminInstruction', () => {
    return commandProcessorEventBusMqEmitter({ mqName: 'test-mq' })().then(
      (bus) => {
        expect(bus).toHaveProperty('publishEvent');
        expect(bus).toHaveProperty('publishReplayEvent');
        expect(bus).toHaveProperty('publishCatchupEvent');
        expect(bus).toHaveProperty('publishAdminInstruction');
        expect(bus).toHaveProperty('subscribeAdminMessages');
        expect(typeof bus.publishEvent).toBe('function');
        expect(typeof bus.publishReplayEvent).toBe('function');
        expect(typeof bus.publishCatchupEvent).toBe('function');
        expect(typeof bus.publishAdminInstruction).toBe('function');
        expect(typeof bus.subscribeAdminMessages).toBe('function');
      },
    );
  });

  test('does not expose publishReplayState, publishSystemMessage, subscribeSystemMessages, or subscribeAdminReply', () => {
    return commandProcessorEventBusMqEmitter({ mqName: 'test-mq' })().then(
      (bus) => {
        expect(bus).not.toHaveProperty('publishReplayState');
        expect(bus).not.toHaveProperty('publishSystemMessage');
        expect(bus).not.toHaveProperty('subscribeSystemMessages');
        expect(bus).not.toHaveProperty('subscribeAdminReply');
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

  test('publishReplayEvent includes targetEndpointName when provided', () => {
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
            targetEndpointName: 'orders-service',
          },
        });
      },
    );
  });

  test('publishReplayEvent omits targetEndpointName when not provided', () => {
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

  test('publishCatchupEvent emits on __catchup topic with correct payload', () => {
    return commandProcessorEventBusMqEmitter({ mqName: 'test-mq' })().then(
      (bus) => {
        const event = { type: 'ORDER_PLACED', timestamp: 67890 };
        bus.publishCatchupEvent('corr-2')('orders', event, 'ep1');

        expect(mockEmitter.emit).toHaveBeenCalledWith({
          topic: '__catchup',
          payload: {
            correlationId: 'corr-2',
            targetReadModel: 'orders',
            event,
            targetEndpointName: 'ep1',
          },
        });
      },
    );
  });

  test('publishAdminInstruction emits on __admin topic', () => {
    return commandProcessorEventBusMqEmitter({ mqName: 'test-mq' })().then(
      (bus) => {
        const instruction = { type: 'replay', readModel: 'items' };
        bus.publishAdminInstruction('corr-3')(instruction);

        expect(mockEmitter.emit).toHaveBeenCalledWith({
          topic: '__admin',
          payload: { correlationId: 'corr-3', instruction },
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
