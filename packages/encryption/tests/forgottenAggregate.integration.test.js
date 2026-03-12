import { describe, test, expect, vi, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { MongoDBContainer } from '@testcontainers/mongodb';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

// Mock OpenTelemetry — command processor imports these
vi.mock('@opentelemetry/api', () => {
  const mockSpan = {
    end: vi.fn(),
    setStatus: vi.fn(),
    recordException: vi.fn(),
    setAttribute: vi.fn(),
    setAttributes: vi.fn(),
  };
  return {
    metrics: {
      getMeter: () => ({
        createCounter: () => ({ add: vi.fn() }),
      }),
    },
    trace: {
      getTracer: () => ({
        startSpan: () => mockSpan,
        startActiveSpan: (name, opts, fn) => fn(mockSpan),
      }),
    },
    context: {
      with: (ctx, fn) => fn(),
    },
    SpanStatusCode: { ERROR: 2 },
  };
});

const { createEncryption } = await import('../encryption.js');
const { defineEncryptionSchema } = await import('../schema.js');
const { inMemoryKeyStore } = await import('../keystores/inmemory.js');
const { subjectLifecycleAggregate } = await import('../subjectLifecycle.js');
const { inmemory: inmemoryAggregateStore } =
  await import('../../aggregatestore-inmemory/index.js');
const { mongodb: mongoEventStore } =
  await import('../../eventstore-mongodb/index.js');
const { handleCommand } =
  await import('../../command-processor/handleCommand.js');
const { createApiHandler } =
  await import('../../express/command-receiver/command-api-handler.js');

const personalKEK = randomBytes(32);

const schema = defineEncryptionSchema({
  events: {
    CUSTOMER_CREATED: {
      'payload.name': {
        context: 'personal',
        subjectField: 'aggregateId',
      },
    },
    CUSTOMER_UPDATED: {
      'payload.name': {
        context: 'personal',
        subjectField: 'aggregateId',
      },
    },
  },
});

const contexts = {
  personal: { roles: ['admin', 'support'] },
};

const isForgotten = (value) =>
  value && typeof value === 'object' && value.forgotten === true;

const validationError = (message) => {
  const err = new Error(message);
  err.name = 'ValidationError';
  return err;
};

const customerAggregate = {
  initial: () => ({}),
  commands: {
    CREATE: (aggregate, payload) => ({
      type: 'CUSTOMER_CREATED',
      payload,
    }),
    UPDATE: (aggregate, payload) => ({
      type: 'CUSTOMER_UPDATED',
      payload,
    }),
  },
  projections: {
    CUSTOMER_CREATED: (state, event) => ({
      ...state,
      name: event.payload.name,
      creationTimestamp: event.timestamp,
    }),
    CUSTOMER_UPDATED: (state, event) => ({
      ...state,
      name: event.payload.name,
    }),
    SUBJECT_FORGOTTEN: (state, event) => ({
      ...state,
      forgotten: true,
      forgottenAt: event.timestamp,
    }),
  },
};

const customerAggregateWithValidation = {
  ...customerAggregate,
  commands: {
    ...customerAggregate.commands,
    UPDATE: (aggregate, payload) => {
      if (isForgotten(aggregate.name)) {
        throw validationError(
          "Cannot modify aggregate: field 'name' has been forgotten",
        );
      }
      return {
        type: 'CUSTOMER_UPDATED',
        payload,
      };
    },
  },
};

const aggregates = {
  customer: customerAggregate,
  subjectLifecycle: subjectLifecycleAggregate,
};

const mockEventBus = () => ({
  publishEvent: () => (event) => event,
  publishReplayState: () => () => {},
});

const mockReq = (body) => ({
  body,
  auth: undefined,
  headers: {},
  cookies: {},
});

const mockRes = () => {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  res.sendStatus = vi.fn().mockReturnValue(res);
  return res;
};

describe('forgotten aggregate integration', { timeout: 120000 }, () => {
  let container;
  let connectionString;
  let eventStoreFactory;

  beforeAll(async () => {
    container = await new MongoDBContainer('mongo:7').start();
    connectionString =
      container.getConnectionString() + '?directConnection=true';
    eventStoreFactory = mongoEventStore({
      url: connectionString,
      database: 'test-forgotten-aggregate',
      collection: 'events',
    });
  }, 120000);

  afterAll(async () => {
    if (container) await container.stop();
  }, 60000);

  const setupPipeline = () =>
    createEncryption({
      schema,
      keyStore: inMemoryKeyStore({ personal: personalKEK }),
      contexts,
      cache: { maxSize: 100, ttlMs: 60000 },
    }).then((enc) => {
      const aggregateStore = inmemoryAggregateStore()(aggregates);
      const wrappedEventStoreFactory = enc.wrapEventStore(eventStoreFactory);

      return wrappedEventStoreFactory().then((wrappedEventStore) => {
        // Wire the event store ref into aggregate store for on-demand
        // reconstruction (same wiring as context.js)
        if (
          aggregateStore.setEventStoreRef &&
          wrappedEventStore.getEventsForAggregate
        ) {
          aggregateStore.setEventStoreRef(
            wrappedEventStore.getEventsForAggregate,
          );
        }

        const apiHandler = createApiHandler({
          aggregateStore,
          eventStore: wrappedEventStore,
          eventBus: mockEventBus(),
          aggregates,
          handleCommand,
        });

        return { apiHandler, aggregateStore, wrappedEventStore, enc };
      });
    });

  test('forget subject then attempt UPDATE returns 409', () =>
    setupPipeline().then(({ apiHandler }) => {
      // Step 1: CREATE a customer
      const createRes = mockRes();
      return apiHandler(
        mockReq({
          command: 'CREATE',
          aggregateName: 'customer',
          aggregateId: 'cust-int-1',
          payload: { name: 'Alice' },
          correlationId: 'corr-create',
        }),
        createRes,
      )
        .then(() => {
          expect(createRes.sendStatus).toHaveBeenCalledWith(200);
        })
        .then(() => {
          // Step 2: FORGET the subject
          const forgetRes = mockRes();
          return apiHandler(
            mockReq({
              command: 'FORGET_SUBJECT',
              aggregateName: 'subjectLifecycle',
              aggregateId: 'cust-int-1',
              payload: {
                subjectId: 'cust-int-1',
                subjectType: 'customer',
                reason: 'GDPR request',
                requestedBy: 'admin',
              },
              correlationId: 'corr-forget',
            }),
            forgetRes,
          ).then(() => {
            expect(forgetRes.sendStatus).toHaveBeenCalledWith(200);
          });
        })
        .then(() => {
          // Step 3: Attempt UPDATE on forgotten subject
          const updateRes = mockRes();
          return apiHandler(
            mockReq({
              command: 'UPDATE',
              aggregateName: 'customer',
              aggregateId: 'cust-int-1',
              payload: { name: 'Alice Smith' },
              correlationId: 'corr-update',
            }),
            updateRes,
          ).then(() => {
            expect(updateRes.status).toHaveBeenCalledWith(409);
            expect(updateRes.json).toHaveBeenCalledWith({
              error: 'SubjectForgotten',
              message:
                'Cannot modify subject whose personal data has been forgotten',
            });
          });
        });
    }));

  test('command handler validates forgotten fields and returns 400 before encryption layer', () => {
    const validatingAggregates = {
      customer: customerAggregateWithValidation,
      subjectLifecycle: subjectLifecycleAggregate,
    };

    return createEncryption({
      schema,
      keyStore: inMemoryKeyStore({ personal: personalKEK }),
      contexts,
      cache: { maxSize: 100, ttlMs: 60000 },
    }).then((enc) => {
      const aggregateStore = inmemoryAggregateStore()(validatingAggregates);
      const wrappedEventStoreFactory = enc.wrapEventStore(eventStoreFactory);

      return wrappedEventStoreFactory().then((wrappedEventStore) => {
        if (
          aggregateStore.setEventStoreRef &&
          wrappedEventStore.getEventsForAggregate
        ) {
          aggregateStore.setEventStoreRef(
            wrappedEventStore.getEventsForAggregate,
          );
        }

        const apiHandler = createApiHandler({
          aggregateStore,
          eventStore: wrappedEventStore,
          eventBus: mockEventBus(),
          aggregates: validatingAggregates,
          handleCommand,
        });

        // Step 1: CREATE
        const createRes = mockRes();
        return apiHandler(
          mockReq({
            command: 'CREATE',
            aggregateName: 'customer',
            aggregateId: 'cust-int-val-1',
            payload: { name: 'ValidateMe' },
            correlationId: 'corr-val-create',
          }),
          createRes,
        )
          .then(() => {
            expect(createRes.sendStatus).toHaveBeenCalledWith(200);
          })
          .then(() => {
            // Step 2: FORGET
            const forgetRes = mockRes();
            return apiHandler(
              mockReq({
                command: 'FORGET_SUBJECT',
                aggregateName: 'subjectLifecycle',
                aggregateId: 'cust-int-val-1',
                payload: {
                  subjectId: 'cust-int-val-1',
                  subjectType: 'customer',
                  reason: 'GDPR request',
                  requestedBy: 'admin',
                },
                correlationId: 'corr-val-forget',
              }),
              forgetRes,
            ).then(() => {
              expect(forgetRes.sendStatus).toHaveBeenCalledWith(200);
            });
          })
          .then(() => {
            // Step 3: Simulate restart for on-demand reconstruction
            const freshAggregateStore =
              inmemoryAggregateStore()(validatingAggregates);
            if (
              freshAggregateStore.setEventStoreRef &&
              wrappedEventStore.getEventsForAggregate
            ) {
              freshAggregateStore.setEventStoreRef(
                wrappedEventStore.getEventsForAggregate,
              );
            }

            const freshApiHandler = createApiHandler({
              aggregateStore: freshAggregateStore,
              eventStore: wrappedEventStore,
              eventBus: mockEventBus(),
              aggregates: validatingAggregates,
              handleCommand,
            });

            // Step 4: UPDATE rejected at command handler level (400)
            const updateRes = mockRes();
            return freshApiHandler(
              mockReq({
                command: 'UPDATE',
                aggregateName: 'customer',
                aggregateId: 'cust-int-val-1',
                payload: { name: 'NewName' },
                correlationId: 'corr-val-update',
              }),
              updateRes,
            ).then(() => {
              // Command handler validation fires first, returns 400
              // (not 409 from encryption layer)
              expect(updateRes.sendStatus).toHaveBeenCalledWith(400);
            });
          });
      });
    });
  });

  test('forget subject then restart (replay) then attempt UPDATE returns 409', () =>
    setupPipeline().then(
      ({ apiHandler, aggregateStore, wrappedEventStore, enc }) => {
        // Step 1: CREATE a customer
        const createRes = mockRes();
        return apiHandler(
          mockReq({
            command: 'CREATE',
            aggregateName: 'customer',
            aggregateId: 'cust-int-2',
            payload: { name: 'Bob' },
            correlationId: 'corr-create-2',
          }),
          createRes,
        )
          .then(() => {
            expect(createRes.sendStatus).toHaveBeenCalledWith(200);
          })
          .then(() => {
            // Step 2: FORGET the subject
            const forgetRes = mockRes();
            return apiHandler(
              mockReq({
                command: 'FORGET_SUBJECT',
                aggregateName: 'subjectLifecycle',
                aggregateId: 'cust-int-2',
                payload: {
                  subjectId: 'cust-int-2',
                  subjectType: 'customer',
                  reason: 'GDPR request',
                  requestedBy: 'admin',
                },
                correlationId: 'corr-forget-2',
              }),
              forgetRes,
            ).then(() => {
              expect(forgetRes.sendStatus).toHaveBeenCalledWith(200);
            });
          })
          .then(() => {
            // Step 3: Simulate restart — fresh aggregate store with
            // event store ref wired. No replay needed; on-demand
            // reconstruction rebuilds aggregates when commands arrive.
            const freshAggregateStore = inmemoryAggregateStore()(aggregates);

            if (
              freshAggregateStore.setEventStoreRef &&
              wrappedEventStore.getEventsForAggregate
            ) {
              freshAggregateStore.setEventStoreRef(
                wrappedEventStore.getEventsForAggregate,
              );
            }

            const freshApiHandler = createApiHandler({
              aggregateStore: freshAggregateStore,
              eventStore: wrappedEventStore,
              eventBus: mockEventBus(),
              aggregates,
              handleCommand,
            });

            // Step 4: Attempt UPDATE on forgotten subject after restart
            const updateRes = mockRes();
            return freshApiHandler(
              mockReq({
                command: 'UPDATE',
                aggregateName: 'customer',
                aggregateId: 'cust-int-2',
                payload: { name: 'Bob Jones' },
                correlationId: 'corr-update-2',
              }),
              updateRes,
            ).then(() => {
              expect(updateRes.status).toHaveBeenCalledWith(409);
              expect(updateRes.json).toHaveBeenCalledWith({
                error: 'SubjectForgotten',
                message:
                  'Cannot modify subject whose personal data has been forgotten',
              });
            });
          });
      },
    ));
});
