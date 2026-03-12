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
}));

let container;
let redisHost;
let redisPort;
let suppressErrors = false;

// Suppress ECONNRESET/EPIPE/ECONNREFUSED errors during container teardown.
// mqemitter-redis holds open connections that cannot be closed
// from test code, so stopping the container triggers these.
const errorHandler = (err) => {
  if (suppressErrors) return;
  throw err;
};

const rejectionHandler = (reason) => {
  if (suppressErrors) return;
  throw reason;
};

beforeAll(async () => {
  process.on('uncaughtException', errorHandler);
  process.on('unhandledRejection', rejectionHandler);
  container = await new RedisContainer('redis:7').start();
  redisHost = container.getHost();
  redisPort = container.getMappedPort(6379);
});

afterAll(async () => {
  suppressErrors = true;
  if (container) await container.stop();
  await new Promise((resolve) => setTimeout(resolve, 2000));
});

const { mqEmitterRedis } = await import('../command-receiver/index.js');

describe('command-receiver mqEmitterRedis', { timeout: 60000 }, () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('factory returns publishEvent, publishReplayState, publishReplayEvent, and publishSystemMessage', () => {
    const factory = mqEmitterRedis({ host: redisHost, port: redisPort });
    return factory().then((result) => {
      expect(result).toHaveProperty('publishEvent');
      expect(result).toHaveProperty('publishReplayState');
      expect(result).toHaveProperty('publishReplayEvent');
      expect(result).toHaveProperty('publishSystemMessage');
      expect(typeof result.publishEvent).toBe('function');
      expect(typeof result.publishReplayState).toBe('function');
      expect(typeof result.publishReplayEvent).toBe('function');
      expect(typeof result.publishSystemMessage).toBe('function');
    });
  });

  test('publishEvent(correlationId)(event) returns the event', () => {
    const factory = mqEmitterRedis({ host: redisHost, port: redisPort });
    return factory().then((result) => {
      const event = { type: 'TEST_EVENT', timestamp: Date.now() };
      const returned = result.publishEvent('corr-1')(event);
      expect(returned).toEqual(event);
    });
  });

  test('publishReplayState(correlationId)(state) returns the state', () => {
    const factory = mqEmitterRedis({ host: redisHost, port: redisPort });
    return factory().then((result) => {
      const state = true;
      const returned = result.publishReplayState('corr-2')(state);
      expect(returned).toBe(true);
    });
  });

  test('factory returns subscribeSystemMessages', () => {
    const factory = mqEmitterRedis({ host: redisHost, port: redisPort });
    return factory().then((result) => {
      expect(result).toHaveProperty('subscribeSystemMessages');
      expect(typeof result.subscribeSystemMessages).toBe('function');
    });
  });

  test('subscribeSystemMessages receives published system messages', () => {
    const factory = mqEmitterRedis({ host: redisHost, port: redisPort });
    return factory().then(
      (result) =>
        new Promise((resolve) => {
          const message = {
            type: 'REPLAY_EVENTS_DONE',
            readModel: 'testModel',
          };
          result.subscribeSystemMessages((received) => {
            expect(received).toEqual(message);
            resolve();
          });
          setTimeout(() => {
            result.publishSystemMessage('corr-sub-1')(message);
          }, 100);
        }),
    );
  });
});
