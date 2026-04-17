import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  }),
  safeStringify: (obj) => JSON.stringify(obj),
}));

vi.mock('nanoid', () => ({
  nanoid: vi.fn().mockReturnValue('mock-nano-id'),
}));

const mockHandlers = vi.hoisted(() => ({}));
const mockEmitter = vi.hoisted(() => ({
  emit: vi.fn(),
  on: vi.fn((topic, handler, cb) => {
    mockHandlers[topic] = handler;
    if (cb) cb();
  }),
}));

vi.mock('../mqEmitterRegistry.js', () => ({
  getSharedMqEmitter: vi.fn().mockReturnValue(mockEmitter),
}));

const { readModelListenerMqEmitter } =
  await import('../readModelListenerMqEmitter.js');

describe('readModelListenerMqEmitter', () => {
  let context;
  let mockResolver;
  let mockPerRequest;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(mockHandlers).forEach((k) => delete mockHandlers[k]);
    mockEmitter.on.mockImplementation((topic, handler, cb) => {
      mockHandlers[topic] = handler;
      if (cb) cb();
    });

    mockResolver = vi.fn().mockResolvedValue({ data: 'result' });
    mockPerRequest = vi.fn().mockReturnValue('per-request-storage');

    context = {
      readModels: {
        users: {
          resolvers: {
            all: mockResolver,
          },
        },
      },
      storage: {
        perRequest: mockPerRequest,
      },
      correlationConfig: { serviceId: 'TEST' },
    };
  });

  test('subscribes to query topic', () => {
    return readModelListenerMqEmitter({ mqName: 'test-mq' })(context).then(
      () => {
        expect(mockEmitter.on).toHaveBeenCalledWith(
          'query',
          expect.any(Function),
        );
      },
    );
  });

  test('routes query to correct resolver', () => {
    return readModelListenerMqEmitter({ mqName: 'test-mq' })(context).then(
      () => {
        const cb = vi.fn();
        mockHandlers['query'](
          {
            payload: {
              readModelName: 'users',
              resolverName: 'all',
              args: { filter: 'active' },
              replyTopic: 'reply-123',
              correlationId: 'corr-1',
            },
          },
          cb,
        );

        expect(mockResolver).toHaveBeenCalledWith('per-request-storage', {
          filter: 'active',
        });
        expect(mockPerRequest).toHaveBeenCalledWith('corr-1');
        expect(cb).toHaveBeenCalled();
      },
    );
  });

  test('sends result to reply topic', () => {
    return readModelListenerMqEmitter({ mqName: 'test-mq' })(context).then(
      () => {
        const cb = vi.fn();
        mockHandlers['query'](
          {
            payload: {
              readModelName: 'users',
              resolverName: 'all',
              args: {},
              replyTopic: 'reply-456',
              correlationId: 'corr-1',
            },
          },
          cb,
        );

        // Wait for the async resolver to complete
        return new Promise((resolve) => setTimeout(resolve, 10)).then(() => {
          expect(mockEmitter.emit).toHaveBeenCalledWith({
            topic: 'reply-456',
            payload: {
              correlationId: 'corr-1',
              result: { data: 'result' },
            },
          });
        });
      },
    );
  });

  test('generates correlationId when not provided', () => {
    return readModelListenerMqEmitter({ mqName: 'test-mq' })(context).then(
      () => {
        const cb = vi.fn();
        mockHandlers['query'](
          {
            payload: {
              readModelName: 'users',
              resolverName: 'all',
              args: {},
              replyTopic: 'reply-789',
            },
          },
          cb,
        );

        expect(mockPerRequest).toHaveBeenCalledWith('TEST-mock-nano-id');
      },
    );
  });

  test('handles unknown read model gracefully', () => {
    return readModelListenerMqEmitter({ mqName: 'test-mq' })(context).then(
      () => {
        const cb = vi.fn();
        mockHandlers['query'](
          {
            payload: {
              readModelName: 'nonexistent',
              resolverName: 'all',
              args: {},
              replyTopic: 'reply-000',
              correlationId: 'corr-1',
            },
          },
          cb,
        );

        expect(mockResolver).not.toHaveBeenCalled();
        expect(cb).toHaveBeenCalled();
      },
    );
  });

  test('handles unknown resolver gracefully', () => {
    return readModelListenerMqEmitter({ mqName: 'test-mq' })(context).then(
      () => {
        const cb = vi.fn();
        mockHandlers['query'](
          {
            payload: {
              readModelName: 'users',
              resolverName: 'nonexistent',
              args: {},
              replyTopic: 'reply-000',
              correlationId: 'corr-1',
            },
          },
          cb,
        );

        expect(mockResolver).not.toHaveBeenCalled();
        expect(cb).toHaveBeenCalled();
      },
    );
  });

  test('resolver error is caught and logged', () => {
    mockResolver.mockRejectedValue(new Error('resolver failed'));

    return readModelListenerMqEmitter({ mqName: 'test-mq' })(context).then(
      () => {
        const cb = vi.fn();
        mockHandlers['query'](
          {
            payload: {
              readModelName: 'users',
              resolverName: 'all',
              args: {},
              replyTopic: 'reply-err',
              correlationId: 'corr-1',
            },
          },
          cb,
        );

        // cb is called immediately
        expect(cb).toHaveBeenCalled();

        // The error is handled async - emit should not be called
        return new Promise((resolve) => setTimeout(resolve, 10)).then(() => {
          expect(mockEmitter.emit).not.toHaveBeenCalled();
        });
      },
    );
  });
});
