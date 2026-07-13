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

const { commandReceiverMqEmitter } =
  await import('../commandReceiverMqEmitter.js');

describe('commandReceiverMqEmitter', () => {
  let handleCommand;
  let context;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(mockHandlers).forEach((k) => {
      mockHandlers[k] = undefined;
    });
    mockEmitter.on.mockImplementation((topic, handler, cb) => {
      mockHandlers[topic] = handler;
      if (cb) cb();
    });

    handleCommand = vi.fn().mockResolvedValue();
    context = {
      aggregateStore: {},
      eventStore: {},
      eventBus: {},
      aggregates: {
        thing: {
          commands: {
            CREATE: vi.fn(),
          },
        },
      },
      handleCommand,
      correlationConfig: { serviceId: 'TEST' },
    };
  });

  test('subscribes to command topic', () => {
    return commandReceiverMqEmitter({ mqName: 'test-mq' })(context).then(() => {
      expect(mockEmitter.on).toHaveBeenCalledWith(
        'command',
        expect.any(Function),
      );
    });
  });

  test('routes valid command to handleCommand', () => {
    return commandReceiverMqEmitter({ mqName: 'test-mq' })(context).then(() => {
      const cb = vi.fn();
      mockHandlers['command'](
        {
          payload: {
            command: 'CREATE',
            aggregateName: 'thing',
            aggregateId: '123',
            payload: { name: 'test' },
            correlationId: 'corr-1',
          },
        },
        cb,
      );

      expect(handleCommand).toHaveBeenCalledWith(
        context.aggregateStore,
        context.eventStore,
        context.eventBus,
        'CREATE',
        'thing',
        '123',
        { name: 'test' },
        context.aggregates.thing.commands.CREATE,
        undefined,
        undefined,
        'corr-1',
      );
      expect(cb).toHaveBeenCalled();
    });
  });

  test('generates correlationId when not provided', () => {
    return commandReceiverMqEmitter({ mqName: 'test-mq' })(context).then(() => {
      const cb = vi.fn();
      mockHandlers['command'](
        {
          payload: {
            command: 'CREATE',
            aggregateName: 'thing',
            aggregateId: '123',
            payload: {},
          },
        },
        cb,
      );

      expect(handleCommand).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        'CREATE',
        'thing',
        '123',
        {},
        expect.anything(),
        undefined,
        undefined,
        'TEST-mock-nano-id',
      );
    });
  });

  test('uses UNK prefix when no correlationConfig', () => {
    context.correlationConfig = undefined;

    return commandReceiverMqEmitter({ mqName: 'test-mq' })(context).then(() => {
      const cb = vi.fn();
      mockHandlers['command'](
        {
          payload: {
            command: 'CREATE',
            aggregateName: 'thing',
            aggregateId: '123',
            payload: {},
          },
        },
        cb,
      );

      expect(handleCommand).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        'CREATE',
        'thing',
        '123',
        {},
        expect.anything(),
        undefined,
        undefined,
        'UNK-mock-nano-id',
      );
    });
  });

  test('does not call handleCommand for unknown aggregate', () => {
    return commandReceiverMqEmitter({ mqName: 'test-mq' })(context).then(() => {
      const cb = vi.fn();
      mockHandlers['command'](
        {
          payload: {
            command: 'CREATE',
            aggregateName: 'nonexistent',
            aggregateId: '123',
            payload: {},
            correlationId: 'corr-1',
          },
        },
        cb,
      );

      expect(handleCommand).not.toHaveBeenCalled();
      expect(cb).toHaveBeenCalled();
    });
  });

  test('does not call handleCommand for unknown command', () => {
    return commandReceiverMqEmitter({ mqName: 'test-mq' })(context).then(() => {
      const cb = vi.fn();
      mockHandlers['command'](
        {
          payload: {
            command: 'DELETE',
            aggregateName: 'thing',
            aggregateId: '123',
            payload: {},
            correlationId: 'corr-1',
          },
        },
        cb,
      );

      expect(handleCommand).not.toHaveBeenCalled();
      expect(cb).toHaveBeenCalled();
    });
  });

  test('handleCommand error is caught and logged', () => {
    handleCommand.mockRejectedValue(new Error('handler failed'));

    return commandReceiverMqEmitter({ mqName: 'test-mq' })(context).then(() => {
      const cb = vi.fn();
      mockHandlers['command'](
        {
          payload: {
            command: 'CREATE',
            aggregateName: 'thing',
            aggregateId: '123',
            payload: {},
            correlationId: 'corr-1',
          },
        },
        cb,
      );

      // cb is called immediately, error is handled async
      expect(cb).toHaveBeenCalled();
    });
  });

  // CP status bridge (issue #23) — the CP analog of the RM status bridge in
  // readModelListenerMqEmitter (commit d728d08). Lets an in-process bridge
  // (monolith SvelteKit) subscribe to CP status and re-serve it as admin SSE.
  describe('CP status bridge', () => {
    test('subscribes to adminCpStatusQuery topic', () => {
      context.statusTracker = {
        getStatus: vi.fn(),
        onStatusChange: vi.fn(),
      };
      return commandReceiverMqEmitter({ mqName: 'test-mq' })(context).then(
        () => {
          expect(mockEmitter.on).toHaveBeenCalledWith(
            'adminCpStatusQuery',
            expect.any(Function),
          );
        },
      );
    });

    test('adminCpStatusQuery replies with the current CP status', () => {
      const mockStatus = {
        state: 'live',
        commandsProcessed: 7,
        eventsWritten: 7,
      };
      context.statusTracker = {
        getStatus: vi.fn().mockReturnValue(mockStatus),
        onStatusChange: vi.fn(),
      };

      return commandReceiverMqEmitter({ mqName: 'test-mq' })(context).then(
        () => {
          const cb = vi.fn();
          mockHandlers['adminCpStatusQuery'](
            {
              payload: {
                correlationId: 'corr-cp',
                replyTopic: 'cp-status-reply-1',
              },
            },
            cb,
          );

          expect(cb).toHaveBeenCalled();
          expect(context.statusTracker.getStatus).toHaveBeenCalled();
          expect(mockEmitter.emit).toHaveBeenCalledWith({
            topic: 'cp-status-reply-1',
            payload: { correlationId: 'corr-cp', result: mockStatus },
          });
        },
      );
    });

    test('adminCpStatusQuery generates a correlationId when absent', () => {
      context.statusTracker = {
        getStatus: vi.fn().mockReturnValue({ state: 'live' }),
        onStatusChange: vi.fn(),
      };

      return commandReceiverMqEmitter({ mqName: 'test-mq' })(context).then(
        () => {
          const cb = vi.fn();
          mockHandlers['adminCpStatusQuery'](
            { payload: { replyTopic: 'cp-status-reply-2' } },
            cb,
          );

          expect(mockEmitter.emit).toHaveBeenCalledWith({
            topic: 'cp-status-reply-2',
            payload: {
              correlationId: 'TEST-mock-nano-id',
              result: { state: 'live' },
            },
          });
        },
      );
    });

    test('adminCpStatusQuery replies null when no statusTracker', () => {
      return commandReceiverMqEmitter({ mqName: 'test-mq' })(context).then(
        () => {
          const cb = vi.fn();
          mockHandlers['adminCpStatusQuery'](
            {
              payload: {
                correlationId: 'corr-cp',
                replyTopic: 'cp-status-reply-3',
              },
            },
            cb,
          );

          expect(mockEmitter.emit).toHaveBeenCalledWith({
            topic: 'cp-status-reply-3',
            payload: { correlationId: 'corr-cp', result: null },
          });
        },
      );
    });

    test('registers onStatusChange listener when statusTracker exists', () => {
      const onStatusChange = vi.fn();
      context.statusTracker = { getStatus: vi.fn(), onStatusChange };

      return commandReceiverMqEmitter({ mqName: 'test-mq' })(context).then(
        () => {
          expect(onStatusChange).toHaveBeenCalledWith(expect.any(Function));
        },
      );
    });

    test('publishes status changes on adminCpStatusUpdate topic', () => {
      let capturedListener;
      context.statusTracker = {
        getStatus: vi.fn(),
        onStatusChange: vi.fn((listener) => {
          capturedListener = listener;
        }),
      };

      return commandReceiverMqEmitter({ mqName: 'test-mq' })(context).then(
        () => {
          const statusData = { state: 'replaying', commandsProcessed: 3 };
          capturedListener(statusData);

          expect(mockEmitter.emit).toHaveBeenCalledWith({
            topic: 'adminCpStatusUpdate',
            payload: statusData,
          });
        },
      );
    });

    test('does not register onStatusChange when statusTracker is absent', () => {
      return commandReceiverMqEmitter({ mqName: 'test-mq' })(context).then(
        () => {
          // No adminCpStatusUpdate emissions and no crash without a tracker.
          expect(mockEmitter.emit).not.toHaveBeenCalledWith(
            expect.objectContaining({ topic: 'adminCpStatusUpdate' }),
          );
        },
      );
    });
  });
});
