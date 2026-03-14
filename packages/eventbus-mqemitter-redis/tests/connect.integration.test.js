import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { RedisContainer } from '@testcontainers/redis';

let container;
let redisHost;
let redisPort;
let suppressErrors = false;

// Suppress ECONNRESET/EPIPE errors during container teardown.
// mqemitter-redis holds open connections that cannot be closed
// from test code, so stopping the container triggers these.
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

describe('connect', { timeout: 60000 }, () => {
  test('connects to Redis and returns an mqemitter instance', () =>
    connect({ host: redisHost, port: redisPort }).then((mq) => {
      expect(mq).toBeDefined();
      expect(typeof mq.on).toBe('function');
      expect(typeof mq.emit).toBe('function');
    }));

  test('instance has on and emit methods', () =>
    connect({ host: redisHost, port: redisPort }).then((mq) => {
      expect(mq).toHaveProperty('on');
      expect(mq).toHaveProperty('emit');
    }));

  test('can emit and receive a message', () =>
    connect({ host: redisHost, port: redisPort }).then(
      (mq) =>
        new Promise((resolve) => {
          const testPayload = { type: 'TEST_EVENT', data: 'hello' };
          mq.on('test-topic', (msg, cb) => {
            expect(msg.topic).toBe('test-topic');
            expect(msg.payload).toEqual(testPayload);
            cb();
            resolve();
          });

          // Small delay to let subscription register
          setTimeout(() => {
            mq.emit({ topic: 'test-topic', payload: testPayload });
          }, 100);
        }),
    ));
});
