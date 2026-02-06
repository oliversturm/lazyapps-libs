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
import amqp from 'amqplib';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  }),
}));

const { rabbitMq } = await import('../command-receiver/index.js');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('command-receiver integration', { timeout: 60000 }, () => {
  let container;
  let amqpUrl;
  let exchangeCounter = 0;
  let suppressErrors = false;

  const uniqueExchange = () => `cmd-recv-ex-${++exchangeCounter}`;

  // Suppress "Unexpected close" errors during container teardown.
  // The rabbitMq factory creates internal connections that cannot be
  // closed from test code, so stopping the container triggers these.
  const errorHandler = (err) => {
    if (suppressErrors && err.message === 'Unexpected close') return;
    throw err;
  };

  beforeAll(async () => {
    process.on('uncaughtException', errorHandler);
    container = await new RabbitMQContainer('rabbitmq:3-management').start();
    amqpUrl = container.getAmqpUrl();
  }, 60000);

  afterAll(async () => {
    suppressErrors = true;
    if (container) await container.stop();
    await new Promise((resolve) => setTimeout(resolve, 500));
    process.removeListener('uncaughtException', errorHandler);
  }, 60000);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('factory returns publishEvent and publishReplayState', () => {
    const exchange = uniqueExchange();
    const factory = rabbitMq({ url: amqpUrl, exchange });
    return factory().then((result) => {
      expect(result).toHaveProperty('publishEvent');
      expect(result).toHaveProperty('publishReplayState');
      expect(typeof result.publishEvent).toBe('function');
      expect(typeof result.publishReplayState).toBe('function');
    });
  });

  test('publishEvent returns the event', () => {
    const exchange = uniqueExchange();
    const factory = rabbitMq({ url: amqpUrl, exchange });
    return factory().then((result) => {
      const event = { type: 'TEST_EVENT', timestamp: Date.now() };
      const returned = result.publishEvent('corr-1')(event);
      expect(returned).toEqual(event);
    });
  });

  test('publishReplayState returns the state', () => {
    const exchange = uniqueExchange();
    const factory = rabbitMq({ url: amqpUrl, exchange });
    return factory().then((result) => {
      const state = true;
      const returned = result.publishReplayState('corr-2')(state);
      expect(returned).toBe(true);
    });
  });

  test('published events are receivable from the exchange', () => {
    const exchange = uniqueExchange();
    const topic = 'events';
    const received = [];
    let consumerConn;

    return amqp
      .connect(amqpUrl)
      .then((conn) => {
        consumerConn = conn;
        return conn.createChannel();
      })
      .then((ch) =>
        ch
          .assertExchange(exchange, 'topic', { durable: false })
          .then(() => ch.assertQueue('', { exclusive: true }))
          .then((q) =>
            ch.bindQueue(q.queue, exchange, topic).then(() =>
              ch.consume(
                q.queue,
                (msg) => {
                  received.push(JSON.parse(msg.content.toString()));
                },
                { noAck: true },
              ),
            ),
          ),
      )
      .then(() => rabbitMq({ url: amqpUrl, exchange, topic })())
      .then(({ publishEvent }) => {
        publishEvent('corr-3')({
          type: 'ITEM_CREATED',
          timestamp: 1234567890,
        });
        return delay(500);
      })
      .then(() => {
        expect(received).toHaveLength(1);
        expect(received[0]).toEqual({
          correlationId: 'corr-3',
          event: { type: 'ITEM_CREATED', timestamp: 1234567890 },
        });
        return consumerConn.close();
      });
  });

  test('published replay state is receivable on __system topic', () => {
    const exchange = uniqueExchange();
    const received = [];
    let consumerConn;

    return amqp
      .connect(amqpUrl)
      .then((conn) => {
        consumerConn = conn;
        return conn.createChannel();
      })
      .then((ch) =>
        ch
          .assertExchange(exchange, 'topic', { durable: false })
          .then(() => ch.assertQueue('', { exclusive: true }))
          .then((q) =>
            ch.bindQueue(q.queue, exchange, '__system').then(() =>
              ch.consume(
                q.queue,
                (msg) => {
                  received.push(JSON.parse(msg.content.toString()));
                },
                { noAck: true },
              ),
            ),
          ),
      )
      .then(() => rabbitMq({ url: amqpUrl, exchange })())
      .then(({ publishReplayState }) => {
        publishReplayState('corr-4')(true);
        return delay(500);
      })
      .then(() => {
        expect(received).toHaveLength(1);
        expect(received[0]).toEqual({
          correlationId: 'corr-4',
          event: { type: 'SET_REPLAY_STATE', state: true },
        });
        return consumerConn.close();
      });
  });
});
