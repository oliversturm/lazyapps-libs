import {
  describe,
  test,
  expect,
  vi,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
} from 'vitest';
import { MongoDBContainer } from '@testcontainers/mongodb';
import { MongoClient } from 'mongodb';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  }),
}));

const { mongodb } = await import('../index.js');

describe('eventstore-mongodb', { timeout: 60000 }, () => {
  let container;
  let connectionString;

  beforeAll(async () => {
    container = await new MongoDBContainer('mongo:7').start();
    connectionString =
      container.getConnectionString() + '?directConnection=true';
  }, 60000);

  afterAll(async () => {
    if (container) await container.stop();
  }, 60000);

  describe('factory', () => {
    test('connects and returns object with addEvent, close, replay', () =>
      mongodb({ url: connectionString })().then((store) => {
        expect(store).toHaveProperty('addEvent');
        expect(store).toHaveProperty('close');
        expect(store).toHaveProperty('replay');
        expect(typeof store.addEvent).toBe('function');
        expect(typeof store.close).toBe('function');
        expect(typeof store.replay).toBe('function');
        return store.close();
      }));
  });

  describe('addEvent', () => {
    let store;

    beforeEach(async () => {
      const client = await MongoClient.connect(connectionString);
      await client.db('events').collection('events').deleteMany({});
      await client.close();
      store = await mongodb({ url: connectionString })();
    }, 30000);

    afterEach(async () => {
      if (store) await store.close();
    });

    test('inserts event and returns it without _id', () => {
      const event = {
        type: 'TEST_EVENT',
        payload: { value: 42 },
        timestamp: Date.now(),
      };

      return store
        .addEvent('corr-1')(event)
        .then((result) => {
          expect(result).toEqual(event);
          expect(result._id).toBeUndefined();
        });
    });

    test('event is retrievable from MongoDB after insert', () => {
      const event = {
        type: 'STORED_EVENT',
        payload: { name: 'test' },
        timestamp: Date.now(),
      };

      return store
        .addEvent('corr-2')(event)
        .then(() => MongoClient.connect(connectionString))
        .then((client) =>
          client
            .db('events')
            .collection('events')
            .find({})
            .toArray()
            .then((docs) => {
              client.close();
              return docs;
            }),
        )
        .then((docs) => {
          expect(docs.length).toBe(1);
          expect(docs[0].type).toBe('STORED_EVENT');
          expect(docs[0].payload).toEqual({ name: 'test' });
        });
    });

    test('strips _id from the returned event object', () => {
      const event = { type: 'ID_TEST', timestamp: Date.now() };

      return store
        .addEvent('corr-3')(event)
        .then((result) => {
          expect(result).not.toHaveProperty('_id');
          expect(result.type).toBe('ID_TEST');
        });
    });
  });

  describe('replay', () => {
    let store;
    let mockCmdProcContext;

    beforeEach(async () => {
      const client = await MongoClient.connect(connectionString);
      await client.db('events').collection('events').deleteMany({});
      await client.close();

      store = await mongodb({ url: connectionString })();

      mockCmdProcContext = {
        aggregateStore: {
          startReplay: vi.fn().mockResolvedValue(),
          endReplay: vi.fn().mockResolvedValue(),
          applyAggregateProjection: vi.fn(() => vi.fn().mockResolvedValue()),
        },
        eventBus: {
          publishReplayState: vi.fn(() => vi.fn().mockResolvedValue()),
        },
      };
    }, 30000);

    afterEach(async () => {
      if (store) await store.close();
    });

    test('calls startReplay and endReplay on aggregateStore', () =>
      store
        .replay('corr-r1')(mockCmdProcContext)
        .then(() => {
          expect(
            mockCmdProcContext.aggregateStore.startReplay,
          ).toHaveBeenCalledOnce();
          expect(
            mockCmdProcContext.aggregateStore.endReplay,
          ).toHaveBeenCalledOnce();
        }));

    test('calls publishReplayState(true) then publishReplayState(false)', () =>
      store
        .replay('corr-r2')(mockCmdProcContext)
        .then(() => {
          expect(
            mockCmdProcContext.eventBus.publishReplayState,
          ).toHaveBeenCalledTimes(2);
          expect(
            mockCmdProcContext.eventBus.publishReplayState,
          ).toHaveBeenCalledWith('corr-r2');

          const calls =
            mockCmdProcContext.eventBus.publishReplayState.mock.results;
          const innerFn0 = calls[0].value;
          const innerFn1 = calls[1].value;
          expect(innerFn0).toHaveBeenCalledWith(true);
          expect(innerFn1).toHaveBeenCalledWith(false);
        }));

    test('calls applyAggregateProjection for each stored event', () =>
      store
        .addEvent('corr-r3')({ type: 'EVT_1', timestamp: 1 })
        .then(() => store.addEvent('corr-r3')({ type: 'EVT_2', timestamp: 2 }))
        .then(() => store.replay('corr-r3')(mockCmdProcContext))
        .then(() => {
          expect(
            mockCmdProcContext.aggregateStore.applyAggregateProjection,
          ).toHaveBeenCalledTimes(2);
          expect(
            mockCmdProcContext.aggregateStore.applyAggregateProjection,
          ).toHaveBeenCalledWith('corr-r3');
        }));

    test('handles empty event store without errors', () =>
      store
        .replay('corr-r4')(mockCmdProcContext)
        .then(() => {
          expect(
            mockCmdProcContext.aggregateStore.startReplay,
          ).toHaveBeenCalledOnce();
          expect(
            mockCmdProcContext.aggregateStore.endReplay,
          ).toHaveBeenCalledOnce();
          expect(
            mockCmdProcContext.aggregateStore.applyAggregateProjection,
          ).not.toHaveBeenCalled();
        }));
  });

  describe('countEvents', () => {
    let store;

    beforeEach(async () => {
      const client = await MongoClient.connect(connectionString);
      await client.db('events').collection('events').deleteMany({});
      await client.close();
      store = await mongodb({ url: connectionString })();
    }, 30000);

    afterEach(async () => {
      if (store) await store.close();
    });

    test('returns correct count for a timestamp range', () =>
      store
        .addEvent('corr-c1')({ type: 'A', timestamp: 100 })
        .then(() => store.addEvent('corr-c1')({ type: 'B', timestamp: 200 }))
        .then(() => store.addEvent('corr-c1')({ type: 'C', timestamp: 300 }))
        .then(() => store.countEvents(100, 200))
        .then((count) => {
          expect(count).toBe(2);
        }));

    test('with no toTimestamp counts from fromTimestamp to end', () =>
      store
        .addEvent('corr-c2')({ type: 'A', timestamp: 100 })
        .then(() => store.addEvent('corr-c2')({ type: 'B', timestamp: 200 }))
        .then(() => store.addEvent('corr-c2')({ type: 'C', timestamp: 300 }))
        .then(() => store.countEvents(150))
        .then((count) => {
          expect(count).toBe(2);
        }));

    test('returns 0 when no events in range', () =>
      store
        .addEvent('corr-c3')({ type: 'A', timestamp: 100 })
        .then(() => store.countEvents(200, 300))
        .then((count) => {
          expect(count).toBe(0);
        }));
  });

  describe('getLatestEventTimestamp', () => {
    let store;

    beforeEach(async () => {
      const client = await MongoClient.connect(connectionString);
      await client.db('events').collection('events').deleteMany({});
      await client.close();
      store = await mongodb({ url: connectionString })();
    }, 30000);

    afterEach(async () => {
      if (store) await store.close();
    });

    test('returns the most recent timestamp', () =>
      store
        .addEvent('corr-l1')({ type: 'A', timestamp: 100 })
        .then(() => store.addEvent('corr-l1')({ type: 'B', timestamp: 300 }))
        .then(() => store.addEvent('corr-l1')({ type: 'C', timestamp: 200 }))
        .then(() => store.getLatestEventTimestamp())
        .then((ts) => {
          expect(ts).toBe(300);
        }));

    test('returns null for empty collection', () =>
      store.getLatestEventTimestamp().then((ts) => {
        expect(ts).toBeNull();
      }));
  });

  describe('streamEvents', () => {
    let store;

    beforeEach(async () => {
      const client = await MongoClient.connect(connectionString);
      await client.db('events').collection('events').deleteMany({});
      await client.close();
      store = await mongodb({ url: connectionString })();
    }, 30000);

    afterEach(async () => {
      if (store) await store.close();
    });

    test('returns events in ascending timestamp order', () =>
      store
        .addEvent('corr-s1')({ type: 'A', timestamp: 300 })
        .then(() => store.addEvent('corr-s1')({ type: 'B', timestamp: 100 }))
        .then(() => store.addEvent('corr-s1')({ type: 'C', timestamp: 200 }))
        .then(() => store.streamEvents(0).toArray())
        .then((events) => {
          expect(events).toHaveLength(3);
          expect(events[0].timestamp).toBe(100);
          expect(events[1].timestamp).toBe(200);
          expect(events[2].timestamp).toBe(300);
        }));

    test('cursor can be iterated with .next()', () =>
      store
        .addEvent('corr-s2')({ type: 'A', timestamp: 100 })
        .then(() => store.addEvent('corr-s2')({ type: 'B', timestamp: 200 }))
        .then(() => {
          const cursor = store.streamEvents(0);
          return cursor
            .next()
            .then((first) => {
              expect(first.type).toBe('A');
              return cursor.next();
            })
            .then((second) => {
              expect(second.type).toBe('B');
              return cursor.next();
            })
            .then((done) => {
              expect(done).toBeNull();
            });
        }));

    test('with range returns only events in range', () =>
      store
        .addEvent('corr-s3')({ type: 'A', timestamp: 100 })
        .then(() => store.addEvent('corr-s3')({ type: 'B', timestamp: 200 }))
        .then(() => store.addEvent('corr-s3')({ type: 'C', timestamp: 300 }))
        .then(() => store.addEvent('corr-s3')({ type: 'D', timestamp: 400 }))
        .then(() => store.streamEvents(200, 300).toArray())
        .then((events) => {
          expect(events).toHaveLength(2);
          expect(events[0].type).toBe('B');
          expect(events[1].type).toBe('C');
        }));
  });

  describe('close', () => {
    test('works without error', () =>
      mongodb({ url: connectionString })().then((store) =>
        expect(store.close()).resolves.not.toThrow(),
      ));
  });
});
