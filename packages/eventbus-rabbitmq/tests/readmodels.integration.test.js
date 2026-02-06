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

const { rabbitMq } = await import('../readmodels/index.js');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('readmodels eventbus-rabbitmq integration', { timeout: 60000 }, () => {
  let container;
  let amqpUrl;
  let exchangeCounter = 0;
  let suppressErrors = false;

  const uniqueExchange = () => `rm-ex-${++exchangeCounter}`;

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

  test('subscribes and receives events from the exchange', () => {
    const exchange = uniqueExchange();
    const projectEventInner = vi.fn();
    const context = {
      projectionHandler: {
        projectEvent: vi.fn(() => projectEventInner),
      },
    };
    const event = { type: 'ITEM_CREATED', payload: { id: '1' } };
    let pubConn;

    return rabbitMq({ url: amqpUrl, exchange })(context)
      .then(() => delay(200))
      .then(() => amqp.connect(amqpUrl))
      .then((conn) => {
        pubConn = conn;
        return conn.createChannel();
      })
      .then((ch) =>
        ch.assertExchange(exchange, 'topic', { durable: false }).then(() => {
          ch.publish(
            exchange,
            'events',
            Buffer.from(JSON.stringify({ correlationId: 'corr-10', event })),
          );
          return delay(500);
        }),
      )
      .then(() => {
        expect(context.projectionHandler.projectEvent).toHaveBeenCalledWith(
          'corr-10',
        );
        expect(projectEventInner).toHaveBeenCalledWith(event, false);
        return pubConn.close();
      });
  });

  test('calls projectionHandler.projectEvent for non-system messages', () => {
    const exchange = uniqueExchange();
    const projectEventInner = vi.fn();
    const context = {
      projectionHandler: {
        projectEvent: vi.fn(() => projectEventInner),
      },
    };
    const event1 = { type: 'FIRST_EVENT', payload: {} };
    const event2 = { type: 'SECOND_EVENT', payload: {} };
    let pubConn;

    return rabbitMq({ url: amqpUrl, exchange })(context)
      .then(() => delay(200))
      .then(() => amqp.connect(amqpUrl))
      .then((conn) => {
        pubConn = conn;
        return conn.createChannel();
      })
      .then((ch) =>
        ch.assertExchange(exchange, 'topic', { durable: false }).then(() => {
          ch.publish(
            exchange,
            'events',
            Buffer.from(
              JSON.stringify({ correlationId: 'corr-20', event: event1 }),
            ),
          );
          ch.publish(
            exchange,
            'events',
            Buffer.from(
              JSON.stringify({ correlationId: 'corr-21', event: event2 }),
            ),
          );
          return delay(500);
        }),
      )
      .then(() => {
        expect(context.projectionHandler.projectEvent).toHaveBeenCalledTimes(2);
        expect(context.projectionHandler.projectEvent).toHaveBeenCalledWith(
          'corr-20',
        );
        expect(context.projectionHandler.projectEvent).toHaveBeenCalledWith(
          'corr-21',
        );
        expect(projectEventInner).toHaveBeenCalledWith(event1, false);
        expect(projectEventInner).toHaveBeenCalledWith(event2, false);
        return pubConn.close();
      });
  });

  test('handles SET_REPLAY_STATE system messages', () => {
    const exchange = uniqueExchange();
    const projectEventInner = vi.fn();
    const context = {
      projectionHandler: {
        projectEvent: vi.fn(() => projectEventInner),
      },
    };
    const event = { type: 'REPLAYED_EVENT', payload: {} };
    const event2 = { type: 'NORMAL_EVENT', payload: {} };
    let pubConn;
    let pubCh;

    return rabbitMq({ url: amqpUrl, exchange })(context)
      .then(() => delay(200))
      .then(() => amqp.connect(amqpUrl))
      .then((conn) => {
        pubConn = conn;
        return conn.createChannel();
      })
      .then((ch) => {
        pubCh = ch;
        return ch.assertExchange(exchange, 'topic', { durable: false });
      })
      .then(() => {
        // Send SET_REPLAY_STATE = true
        pubCh.publish(
          exchange,
          '__system',
          Buffer.from(
            JSON.stringify({
              correlationId: 'corr-30',
              event: { type: 'SET_REPLAY_STATE', state: true },
            }),
          ),
        );
        return delay(300);
      })
      .then(() => {
        // Now send a regular event -- it should be projected with inReplay=true
        pubCh.publish(
          exchange,
          'events',
          Buffer.from(JSON.stringify({ correlationId: 'corr-31', event })),
        );
        return delay(500);
      })
      .then(() => {
        // The system message should NOT have triggered projectEvent
        expect(context.projectionHandler.projectEvent).toHaveBeenCalledTimes(1);
        expect(context.projectionHandler.projectEvent).toHaveBeenCalledWith(
          'corr-31',
        );
        expect(projectEventInner).toHaveBeenCalledWith(event, true);

        // Send SET_REPLAY_STATE = false
        pubCh.publish(
          exchange,
          '__system',
          Buffer.from(
            JSON.stringify({
              correlationId: 'corr-32',
              event: { type: 'SET_REPLAY_STATE', state: false },
            }),
          ),
        );
        return delay(300);
      })
      .then(() => {
        // Send another event -- should be projected with inReplay=false
        pubCh.publish(
          exchange,
          'events',
          Buffer.from(
            JSON.stringify({ correlationId: 'corr-33', event: event2 }),
          ),
        );
        return delay(500);
      })
      .then(() => {
        expect(context.projectionHandler.projectEvent).toHaveBeenCalledTimes(2);
        expect(projectEventInner).toHaveBeenCalledWith(event2, false);
        return pubConn.close();
      });
  });
});
