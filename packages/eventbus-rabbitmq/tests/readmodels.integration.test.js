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

// Shared logger object so tests can assert on error calls across any
// correlation ID used by the consumer.
const loggerSpy = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};
vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn(() => loggerSpy),
  safeStringify: (obj) => JSON.stringify(obj),
  redactUrl: (v) => v,
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
    loggerSpy.debug.mockClear();
    loggerSpy.info.mockClear();
    loggerSpy.warn.mockClear();
    loggerSpy.error.mockClear();
  });

  test('SEC-25: malformed JSON does not crash consumer; error logged; subsequent valid messages still processed', () => {
    const exchange = uniqueExchange();
    const projectEventInner = vi.fn();
    const context = {
      projectionHandler: {
        projectEvent: vi.fn(() => projectEventInner),
      },
    };
    const validEvent = { type: 'VALID_AFTER_GARBAGE', payload: { ok: 1 } };
    let pubConn;

    // While the fix is missing, the consumer's synchronous JSON.parse throws
    // an uncaughtException that the suite-level errorHandler re-throws,
    // tearing the worker down before assertions run. For this test only,
    // detach the strict handler and swallow parse errors so the test can
    // deterministically observe whether the consumer survived.
    process.removeListener('uncaughtException', errorHandler);
    const swallow = vi.fn();
    process.on('uncaughtException', swallow);

    return rabbitMq({ url: amqpUrl, exchange })(context)
      .then(() => delay(200))
      .then(() => amqp.connect(amqpUrl))
      .then((conn) => {
        pubConn = conn;
        return conn.createChannel();
      })
      .then((ch) =>
        ch.assertExchange(exchange, 'topic', { durable: false }).then(() => {
          // 1) Publish malformed payload.
          ch.publish(exchange, 'events', Buffer.from('this-is-not-json{{'));
          // 2) Publish a valid payload after the malformed one.
          ch.publish(
            exchange,
            'events',
            Buffer.from(
              JSON.stringify({
                correlationId: 'corr-valid',
                event: validEvent,
              }),
            ),
          );
          return delay(800);
        }),
      )
      .then(() => {
        // Consumer must have survived and processed the valid message.
        expect(context.projectionHandler.projectEvent).toHaveBeenCalledWith(
          'corr-valid',
        );
        expect(projectEventInner).toHaveBeenCalledWith(validEvent, false);

        // An error log must be emitted for the malformed message. The
        // current (unpatched) code throws synchronously inside the consumer
        // callback and never reaches a log.error call — so this assertion
        // fails until the fix lands.
        expect(loggerSpy.error).toHaveBeenCalled();
        const errorMsgs = loggerSpy.error.mock.calls
          .map((c) => c[0])
          .join('\n');
        expect(errorMsgs).toMatch(/malformed|parse|invalid|JSON/i);
      })
      .finally(() => {
        process.removeListener('uncaughtException', swallow);
        process.on('uncaughtException', errorHandler);
        return pubConn && pubConn.close();
      });
  });

  test('SEC-25: malformed JSON on __system routing key does not crash consumer', () => {
    const exchange = uniqueExchange();
    const projectEventInner = vi.fn();
    const context = {
      projectionHandler: {
        projectEvent: vi.fn(() => projectEventInner),
      },
    };
    const validEvent = { type: 'VALID_NONSYS', payload: {} };
    let pubConn;

    process.removeListener('uncaughtException', errorHandler);
    const swallow = vi.fn();
    process.on('uncaughtException', swallow);

    return rabbitMq({ url: amqpUrl, exchange })(context)
      .then(() => delay(200))
      .then(() => amqp.connect(amqpUrl))
      .then((conn) => {
        pubConn = conn;
        return conn.createChannel();
      })
      .then((ch) =>
        ch.assertExchange(exchange, 'topic', { durable: false }).then(() => {
          // Malformed on __system routing key.
          ch.publish(exchange, '__system', Buffer.from('not-json'));
          // Then valid event afterwards.
          ch.publish(
            exchange,
            'events',
            Buffer.from(
              JSON.stringify({
                correlationId: 'corr-after-sys-garbage',
                event: validEvent,
              }),
            ),
          );
          return delay(800);
        }),
      )
      .then(() => {
        expect(context.projectionHandler.projectEvent).toHaveBeenCalledWith(
          'corr-after-sys-garbage',
        );
        expect(projectEventInner).toHaveBeenCalledWith(validEvent, false);
        expect(loggerSpy.error).toHaveBeenCalled();
      })
      .finally(() => {
        process.removeListener('uncaughtException', swallow);
        process.on('uncaughtException', errorHandler);
        return pubConn && pubConn.close();
      });
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
