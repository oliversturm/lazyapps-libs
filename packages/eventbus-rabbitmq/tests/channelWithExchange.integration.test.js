import {
  describe,
  test,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterAll,
} from 'vitest';
import { RabbitMQContainer } from '@testcontainers/rabbitmq';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  }),
  redactUrl: (v) => v,
}));

const { channelWithExchange } = await import('../channelWithExchange.js');

describe('channelWithExchange integration', { timeout: 60000 }, () => {
  let container;
  let amqpUrl;

  beforeAll(async () => {
    container = await new RabbitMQContainer('rabbitmq:3-management').start();
    amqpUrl = container.getAmqpUrl();
  }, 60000);

  afterAll(async () => {
    if (container) await container.stop();
  }, 60000);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('connects and returns conn and channel', () => {
    const log = { debug: vi.fn(), info: vi.fn(), error: vi.fn() };
    return channelWithExchange(
      { url: amqpUrl, socketOptions: {}, exchange: 'test-exchange-1' },
      log,
    ).then((result) => {
      expect(result).toHaveProperty('conn');
      expect(result).toHaveProperty('channel');
      return result.conn.close();
    });
  });

  test('asserts a topic exchange', () => {
    const log = { debug: vi.fn(), info: vi.fn(), error: vi.fn() };
    return channelWithExchange(
      { url: amqpUrl, socketOptions: {}, exchange: 'test-exchange-2' },
      log,
    ).then((result) => {
      expect(log.info).toHaveBeenCalledWith(
        expect.stringContaining('test-exchange-2'),
      );
      return result.conn.close();
    });
  });

  test('connection can be closed without error', () => {
    const log = { debug: vi.fn(), info: vi.fn(), error: vi.fn() };
    return channelWithExchange(
      { url: amqpUrl, socketOptions: {}, exchange: 'test-exchange-3' },
      log,
    ).then((result) => expect(result.conn.close()).resolves.toBeUndefined());
  });
});
