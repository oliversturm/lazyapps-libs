import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  }),
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
    Object.keys(mockHandlers).forEach((k) => {
      mockHandlers[k] = undefined;
    });
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
      endpointName: 'TEST',
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

  test('subscribes to adminQuery topic', () => {
    return readModelListenerMqEmitter({ mqName: 'test-mq' })(context).then(
      () => {
        expect(mockEmitter.on).toHaveBeenCalledWith(
          'adminQuery',
          expect.any(Function),
        );
      },
    );
  });

  test('adminQuery returns read model status data', () => {
    context.projectionHandler = {
      getReadModelReplayStates: vi.fn().mockReturnValue({}),
      getFifoQueueSize: vi.fn().mockReturnValue(0),
    };
    context.lifecycleManager = {
      getState: vi.fn().mockReturnValue('live'),
    };
    context.readModels.users.lastProjectedEventTimestamp = 999;

    return readModelListenerMqEmitter({ mqName: 'test-mq' })(context).then(
      () => {
        const cb = vi.fn();
        mockHandlers['adminQuery'](
          {
            payload: {
              correlationId: 'corr-adm',
              replyTopic: 'admin-reply-123',
            },
          },
          cb,
        );

        expect(cb).toHaveBeenCalled();
        expect(mockEmitter.emit).toHaveBeenCalledWith({
          topic: 'admin-reply-123',
          payload: {
            correlationId: 'corr-adm',
            result: [
              {
                name: 'users',
                endpointName: 'TEST',
                lastProjectedEventTimestamp: 999,
                status: 'active',
                state: 'live',
                stateVersion: 0,
                fifoQueueSize: 0,
              },
            ],
          },
        });
      },
    );
  });

  test('adminQuery marks replaying read models', () => {
    context.projectionHandler = {
      getReadModelReplayStates: vi.fn().mockReturnValue({ users: true }),
    };

    return readModelListenerMqEmitter({ mqName: 'test-mq' })(context).then(
      () => {
        const cb = vi.fn();
        mockHandlers['adminQuery'](
          {
            payload: {
              correlationId: 'corr-adm',
              replyTopic: 'admin-reply-456',
            },
          },
          cb,
        );

        expect(mockEmitter.emit).toHaveBeenCalledWith(
          expect.objectContaining({
            payload: expect.objectContaining({
              result: expect.arrayContaining([
                expect.objectContaining({
                  name: 'users',
                  status: 'replaying',
                }),
              ]),
            }),
          }),
        );
      },
    );
  });

  test('adminQuery works without projectionHandler', () => {
    return readModelListenerMqEmitter({ mqName: 'test-mq' })(context).then(
      () => {
        const cb = vi.fn();
        mockHandlers['adminQuery'](
          {
            payload: {
              correlationId: 'corr-adm',
              replyTopic: 'admin-reply-789',
            },
          },
          cb,
        );

        expect(cb).toHaveBeenCalled();
        expect(mockEmitter.emit).toHaveBeenCalledWith(
          expect.objectContaining({
            topic: 'admin-reply-789',
            payload: expect.objectContaining({
              result: expect.arrayContaining([
                expect.objectContaining({
                  name: 'users',
                  status: 'active',
                }),
              ]),
            }),
          }),
        );
      },
    );
  });

  test('subscribes to adminStatusQuery topic', () => {
    context.statusTracker = {
      getStatus: vi.fn(),
      onStatusChange: vi.fn(),
    };
    return readModelListenerMqEmitter({ mqName: 'test-mq' })(context).then(
      () => {
        expect(mockEmitter.on).toHaveBeenCalledWith(
          'adminStatusQuery',
          expect.any(Function),
        );
      },
    );
  });

  test('adminStatusQuery returns status for specific read model', () => {
    const mockStatus = {
      endpointName: 'TEST',
      readModelName: 'users',
      state: 'live',
      lastProjectedEventTimestamp: 1234,
    };
    context.statusTracker = {
      getStatus: vi.fn().mockReturnValue(mockStatus),
      onStatusChange: vi.fn(),
    };

    return readModelListenerMqEmitter({ mqName: 'test-mq' })(context).then(
      () => {
        const cb = vi.fn();
        mockHandlers['adminStatusQuery'](
          {
            payload: {
              correlationId: 'corr-st',
              replyTopic: 'status-reply-1',
              endpointName: 'TEST',
              readModelName: 'users',
            },
          },
          cb,
        );

        expect(cb).toHaveBeenCalled();
        expect(context.statusTracker.getStatus).toHaveBeenCalledWith('users');
        expect(mockEmitter.emit).toHaveBeenCalledWith({
          topic: 'status-reply-1',
          payload: { correlationId: 'corr-st', result: mockStatus },
        });
      },
    );
  });

  test('adminStatusQuery returns null for unknown read model', () => {
    context.statusTracker = {
      getStatus: vi.fn().mockReturnValue(null),
      onStatusChange: vi.fn(),
    };

    return readModelListenerMqEmitter({ mqName: 'test-mq' })(context).then(
      () => {
        const cb = vi.fn();
        mockHandlers['adminStatusQuery'](
          {
            payload: {
              correlationId: 'corr-st',
              replyTopic: 'status-reply-2',
              endpointName: 'TEST',
              readModelName: 'nonexistent',
            },
          },
          cb,
        );

        expect(mockEmitter.emit).toHaveBeenCalledWith({
          topic: 'status-reply-2',
          payload: { correlationId: 'corr-st', result: null },
        });
      },
    );
  });

  test('subscribes to adminReplayRelevantEventsQuery topic', () => {
    context.statusTracker = {
      onStatusChange: vi.fn(),
    };
    return readModelListenerMqEmitter({ mqName: 'test-mq' })(context).then(
      () => {
        expect(mockEmitter.on).toHaveBeenCalledWith(
          'adminReplayRelevantEventsQuery',
          expect.any(Function),
        );
      },
    );
  });

  test('adminReplayRelevantEventsQuery returns event types', () => {
    context.readModels.users.replayRelevantEvents = [
      'USER_CREATED',
      'USER_UPDATED',
    ];
    context.statusTracker = {
      onStatusChange: vi.fn(),
    };

    return readModelListenerMqEmitter({ mqName: 'test-mq' })(context).then(
      () => {
        const cb = vi.fn();
        mockHandlers['adminReplayRelevantEventsQuery'](
          {
            payload: {
              correlationId: 'corr-rre',
              replyTopic: 'rre-reply-1',
              readModelName: 'users',
            },
          },
          cb,
        );

        expect(cb).toHaveBeenCalled();
        expect(mockEmitter.emit).toHaveBeenCalledWith({
          topic: 'rre-reply-1',
          payload: {
            correlationId: 'corr-rre',
            result: ['USER_CREATED', 'USER_UPDATED'],
          },
        });
      },
    );
  });

  test('adminReplayRelevantEventsQuery returns null for unknown RM', () => {
    context.statusTracker = {
      onStatusChange: vi.fn(),
    };

    return readModelListenerMqEmitter({ mqName: 'test-mq' })(context).then(
      () => {
        const cb = vi.fn();
        mockHandlers['adminReplayRelevantEventsQuery'](
          {
            payload: {
              correlationId: 'corr-rre',
              replyTopic: 'rre-reply-2',
              readModelName: 'nonexistent',
            },
          },
          cb,
        );

        expect(mockEmitter.emit).toHaveBeenCalledWith({
          topic: 'rre-reply-2',
          payload: { correlationId: 'corr-rre', result: null },
        });
      },
    );
  });

  test('registers onStatusChange listener when statusTracker exists', () => {
    const onStatusChange = vi.fn();
    context.statusTracker = { onStatusChange };

    return readModelListenerMqEmitter({ mqName: 'test-mq' })(context).then(
      () => {
        expect(onStatusChange).toHaveBeenCalledWith(expect.any(Function));
      },
    );
  });

  test('publishes status changes on adminStatusUpdate topic', () => {
    let capturedListener;
    context.statusTracker = {
      onStatusChange: vi.fn((listener) => {
        capturedListener = listener;
      }),
    };

    return readModelListenerMqEmitter({ mqName: 'test-mq' })(context).then(
      () => {
        const statusData = {
          endpointName: 'TEST',
          readModelName: 'users',
          state: 'replay',
        };
        capturedListener(statusData);

        expect(mockEmitter.emit).toHaveBeenCalledWith({
          topic: 'adminStatusUpdate',
          payload: statusData,
        });
      },
    );
  });

  test('adminBackupListQuery returns backups', () => {
    const mockBackups = [
      { backupId: 'b1', timestamp: 1000 },
      { backupId: 'b2', timestamp: 2000 },
    ];
    context.backup = {
      listBackups: vi.fn().mockResolvedValue(mockBackups),
    };
    context.statusTracker = { onStatusChange: vi.fn() };

    return readModelListenerMqEmitter({ mqName: 'test-mq' })(context).then(
      () => {
        const cb = vi.fn();
        mockHandlers['adminBackupListQuery'](
          {
            payload: {
              correlationId: 'corr-bk',
              replyTopic: 'backup-reply-1',
              readModelName: 'users',
            },
          },
          cb,
        );

        expect(cb).toHaveBeenCalled();
        return new Promise((resolve) => setTimeout(resolve, 10)).then(() => {
          expect(context.backup.listBackups).toHaveBeenCalledWith('users');
          expect(mockEmitter.emit).toHaveBeenCalledWith({
            topic: 'backup-reply-1',
            payload: { correlationId: 'corr-bk', result: mockBackups },
          });
        });
      },
    );
  });

  test('adminBackupListQuery returns empty when no backup configured', () => {
    context.statusTracker = { onStatusChange: vi.fn() };

    return readModelListenerMqEmitter({ mqName: 'test-mq' })(context).then(
      () => {
        const cb = vi.fn();
        mockHandlers['adminBackupListQuery'](
          {
            payload: {
              correlationId: 'corr-bk',
              replyTopic: 'backup-reply-2',
              readModelName: 'users',
            },
          },
          cb,
        );

        expect(cb).toHaveBeenCalled();
        expect(mockEmitter.emit).toHaveBeenCalledWith({
          topic: 'backup-reply-2',
          payload: { correlationId: 'corr-bk', result: [] },
        });
      },
    );
  });

  test('does not register onStatusChange when statusTracker is absent', () => {
    return readModelListenerMqEmitter({ mqName: 'test-mq' })(context).then(
      () => {
        // No error thrown, no onStatusChange called
        expect(mockEmitter.on).not.toHaveBeenCalledWith(
          'adminStatusUpdate',
          expect.any(Function),
        );
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
