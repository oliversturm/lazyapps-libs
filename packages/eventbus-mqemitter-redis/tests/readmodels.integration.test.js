import {
  describe,
  test,
  expect,
  vi,
  beforeEach,
  beforeAll,
  afterAll,
} from 'vitest';
import { RedisContainer } from '@testcontainers/redis';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  }),
  safeStringify: (obj) => JSON.stringify(obj),
}));

let container;
let redisHost;
let redisPort;
let suppressErrors = false;

const errorHandler = (err) => {
  if (
    suppressErrors &&
    (err.code === 'ECONNRESET' ||
      err.code === 'EPIPE' ||
      err.code === 'ECONNREFUSED')
  )
    return;
  throw err;
};

beforeAll(async () => {
  process.on('uncaughtException', errorHandler);
  container = await new RedisContainer('redis:7').start();
  redisHost = container.getHost();
  redisPort = container.getMappedPort(6379);
});

afterAll(async () => {
  suppressErrors = true;
  if (container) await container.stop();
  // Do not remove the error handler on a timer — mqemitter-redis holds
  // open connections that cannot be closed from test code, and they may
  // throw ECONNREFUSED well after the container stops. The handler only
  // suppresses expected teardown errors (ECONNRESET/EPIPE/ECONNREFUSED)
  // when suppressErrors is true, so it is safe to leave registered.
});

const { connect } = await import('../connect.js');
const { mqEmitterRedis } = await import('../readmodels/index.js');

describe('readmodels mqEmitterRedis', { timeout: 60000 }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('subscribes to events from Redis', () => {
    const projectEventHandler = vi.fn();
    const context = {
      projectionHandler: {
        projectEvent: vi.fn(() => projectEventHandler),
      },
    };

    const testEvent = { type: 'ITEM_CREATED', data: 'test' };

    return mqEmitterRedis({ host: redisHost, port: redisPort })(context)
      .then(() => connect({ host: redisHost, port: redisPort }))
      .then(
        (publisher) =>
          new Promise((resolve) => {
            // Small delay to let subscription register
            setTimeout(() => {
              publisher.emit({
                topic: 'events',
                payload: { correlationId: 'corr-1', event: testEvent },
              });
            }, 200);

            // Wait for message to propagate
            setTimeout(() => {
              expect(
                context.projectionHandler.projectEvent,
              ).toHaveBeenCalledWith('corr-1');
              expect(projectEventHandler).toHaveBeenCalledWith(
                testEvent,
                false,
              );
              resolve();
            }, 500);
          }),
      );
  });

  test('calls projectionHandler.projectEvent for received events', () => {
    const projectEventHandler = vi.fn();
    const context = {
      projectionHandler: {
        projectEvent: vi.fn(() => projectEventHandler),
      },
    };

    const event1 = { type: 'EVENT_A', value: 1 };
    const event2 = { type: 'EVENT_B', value: 2 };

    return mqEmitterRedis({ host: redisHost, port: redisPort })(context)
      .then(() => connect({ host: redisHost, port: redisPort }))
      .then(
        (publisher) =>
          new Promise((resolve) => {
            setTimeout(() => {
              publisher.emit({
                topic: 'events',
                payload: { correlationId: 'corr-a', event: event1 },
              });
              publisher.emit({
                topic: 'events',
                payload: { correlationId: 'corr-b', event: event2 },
              });
            }, 200);

            setTimeout(() => {
              expect(
                context.projectionHandler.projectEvent,
              ).toHaveBeenCalledWith('corr-a');
              expect(
                context.projectionHandler.projectEvent,
              ).toHaveBeenCalledWith('corr-b');
              resolve();
            }, 500);
          }),
      );
  });

  test('handles SET_REPLAY_STATE system messages', () => {
    const projectEventHandler = vi.fn();
    const context = {
      projectionHandler: {
        projectEvent: vi.fn(() => projectEventHandler),
      },
    };

    return mqEmitterRedis({ host: redisHost, port: redisPort })(context)
      .then(() => connect({ host: redisHost, port: redisPort }))
      .then(
        (publisher) =>
          new Promise((resolve) => {
            // First set replay state to true
            setTimeout(() => {
              publisher.emit({
                topic: '__system',
                payload: {
                  correlationId: 'corr-sys',
                  event: { type: 'SET_REPLAY_STATE', state: true },
                },
              });
            }, 200);

            // Then send an event which should be received with inReplay=true
            setTimeout(() => {
              publisher.emit({
                topic: 'events',
                payload: {
                  correlationId: 'corr-replay',
                  event: { type: 'REPLAY_EVENT' },
                },
              });
            }, 400);

            setTimeout(() => {
              expect(projectEventHandler).toHaveBeenCalledWith(
                { type: 'REPLAY_EVENT' },
                true,
              );
              resolve();
            }, 700);
          }),
      );
  });
});
