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

  test('factory returns publishEvent, publishReplayEvent, publishCatchupEvent, and publishAdminInstruction', () => {
    const factory = mqEmitterRedis({ host: redisHost, port: redisPort });
    return factory().then((result) => {
      expect(result).toHaveProperty('publishEvent');
      expect(result).toHaveProperty('publishReplayEvent');
      expect(result).toHaveProperty('publishCatchupEvent');
      expect(result).toHaveProperty('publishAdminInstruction');
      expect(result).toHaveProperty('subscribeAdminMessages');
      expect(typeof result.publishEvent).toBe('function');
      expect(typeof result.publishReplayEvent).toBe('function');
      expect(typeof result.publishCatchupEvent).toBe('function');
      expect(typeof result.publishAdminInstruction).toBe('function');
      expect(typeof result.subscribeAdminMessages).toBe('function');
    });
  });

  test('does not expose publishReplayState, publishSystemMessage, subscribeSystemMessages, or subscribeAdminReply', () => {
    const factory = mqEmitterRedis({ host: redisHost, port: redisPort });
    return factory().then((result) => {
      expect(result).not.toHaveProperty('publishReplayState');
      expect(result).not.toHaveProperty('publishSystemMessage');
      expect(result).not.toHaveProperty('subscribeSystemMessages');
      expect(result).not.toHaveProperty('subscribeAdminReply');
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
});
