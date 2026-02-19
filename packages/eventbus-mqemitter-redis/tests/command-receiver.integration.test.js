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
  await new Promise((resolve) => setTimeout(resolve, 2000));
  process.removeListener('uncaughtException', errorHandler);
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
});
