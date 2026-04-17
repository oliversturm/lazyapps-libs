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
  safeStringify: (obj) => JSON.stringify(obj),
  redactUrl: (v) => v,
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
const { createForgetMixin } = await import('../forgetMixin.js');
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
  personal: { roles: ['admin', 'support'], autoForget: true },
};

const isForgotten = (value) =>
  value && typeof value === 'object' && value.forgotten === true;

const validationError = (message) => {
  const err = new Error(message);
  err.name = 'ValidationError';
  return err;
};

const forgetMixin = createForgetMixin(contexts);

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

// Inject mixin into customer aggregate (simulates what bootstrap does)
const customerWithMixin = {
  ...customerAggregate,
  commands: {
    ...customerAggregate.commands,
    ...forgetMixin.commands,
  },
  projections: {
    ...customerAggregate.projections,
    ...forgetMixin.projections,
  },
};

const customerWithValidationAndMixin = {
  ...customerAggregateWithValidation,
  commands: {
    ...customerAggregateWithValidation.commands,
    ...forgetMixin.commands,
  },
  projections: {
    ...customerAggregateWithValidation.projections,
    ...forgetMixin.projections,
  },
};

const aggregates = {
  customer: customerWithMixin,
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

describe('forgotten aggregate integration (mixin)', { timeout: 120000 }, () => {
  let container;
  let connectionString;
  let eventStoreFactory;

  beforeAll(async () => {
    container = await new MongoDBContainer('mongo:7').start();
    connectionString =
      container.getConnectionString() + '?directConnection=true';
    eventStoreFactory = mongoEventStore({
      url: connectionString,
      database: 'test-forgotten-aggregate-mixin',
      collection: 'events',
    });
  }, 120000);

  afterAll(async () => {
    if (container) await container.stop();
  }, 60000);

  const setupPipeline = (aggDefs = aggregates) =>
    createEncryption({
      schema,
      keyStore: inMemoryKeyStore({ personal: personalKEK }),
      contexts,
      cache: { maxSize: 100, ttlMs: 60000 },
    }).then((enc) => {
      const aggregateStore = inmemoryAggregateStore()(aggDefs);
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
          aggregates: aggDefs,
          handleCommand,
        });

        return { apiHandler, aggregateStore, wrappedEventStore, enc };
      });
    });

  test('FORGET_SUBJECT via mixin → SUBJECT_FORGOTTEN event with contexts → UPDATE returns 409', () =>
    setupPipeline().then(({ apiHandler }) => {
      const createRes = mockRes();
      return apiHandler(
        mockReq({
          command: 'CREATE',
          aggregateName: 'customer',
          aggregateId: 'cust-mixin-1',
          payload: { name: 'Alice' },
          correlationId: 'corr-create',
        }),
        createRes,
      )
        .then(() => {
          expect(createRes.sendStatus).toHaveBeenCalledWith(200);
        })
        .then(() => {
          // FORGET_SUBJECT sent to customer aggregate (handled by mixin)
          const forgetRes = mockRes();
          return apiHandler(
            mockReq({
              command: 'FORGET_SUBJECT',
              aggregateName: 'customer',
              aggregateId: 'cust-mixin-1',
              payload: {
                subjectId: 'cust-mixin-1',
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
          // UPDATE on forgotten subject should return 409
          const updateRes = mockRes();
          return apiHandler(
            mockReq({
              command: 'UPDATE',
              aggregateName: 'customer',
              aggregateId: 'cust-mixin-1',
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

  test('FORGET_SUBJECT_CONTEXT via mixin → shreds single context', () =>
    setupPipeline().then(({ apiHandler }) => {
      const createRes = mockRes();
      return apiHandler(
        mockReq({
          command: 'CREATE',
          aggregateName: 'customer',
          aggregateId: 'cust-mixin-ctx-1',
          payload: { name: 'Bob' },
          correlationId: 'corr-create-ctx',
        }),
        createRes,
      )
        .then(() => {
          expect(createRes.sendStatus).toHaveBeenCalledWith(200);
        })
        .then(() => {
          const forgetCtxRes = mockRes();
          return apiHandler(
            mockReq({
              command: 'FORGET_SUBJECT_CONTEXT',
              aggregateName: 'customer',
              aggregateId: 'cust-mixin-ctx-1',
              payload: {
                contextName: 'personal',
              },
              correlationId: 'corr-forget-ctx',
            }),
            forgetCtxRes,
          ).then(() => {
            expect(forgetCtxRes.sendStatus).toHaveBeenCalledWith(200);
          });
        })
        .then(() => {
          // UPDATE should fail because personal context is forgotten
          const updateRes = mockRes();
          return apiHandler(
            mockReq({
              command: 'UPDATE',
              aggregateName: 'customer',
              aggregateId: 'cust-mixin-ctx-1',
              payload: { name: 'Bob Jones' },
              correlationId: 'corr-update-ctx',
            }),
            updateRes,
          ).then(() => {
            expect(updateRes.status).toHaveBeenCalledWith(409);
          });
        });
    }));

  test('command handler validates forgotten fields at 400 before encryption layer', () => {
    const validatingAggregates = {
      customer: customerWithValidationAndMixin,
    };

    return setupPipeline(validatingAggregates).then(
      ({ apiHandler, wrappedEventStore }) => {
        const createRes = mockRes();
        return apiHandler(
          mockReq({
            command: 'CREATE',
            aggregateName: 'customer',
            aggregateId: 'cust-mixin-val-1',
            payload: { name: 'ValidateMe' },
            correlationId: 'corr-val-create',
          }),
          createRes,
        )
          .then(() => {
            expect(createRes.sendStatus).toHaveBeenCalledWith(200);
          })
          .then(() => {
            const forgetRes = mockRes();
            return apiHandler(
              mockReq({
                command: 'FORGET_SUBJECT',
                aggregateName: 'customer',
                aggregateId: 'cust-mixin-val-1',
                payload: {
                  subjectId: 'cust-mixin-val-1',
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
            // Fresh aggregate store — on-demand reconstruction
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

            const updateRes = mockRes();
            return freshApiHandler(
              mockReq({
                command: 'UPDATE',
                aggregateName: 'customer',
                aggregateId: 'cust-mixin-val-1',
                payload: { name: 'NewName' },
                correlationId: 'corr-val-update',
              }),
              updateRes,
            ).then(() => {
              expect(updateRes.sendStatus).toHaveBeenCalledWith(400);
            });
          });
      },
    );
  });

  test('forget then restart (on-demand reconstruction) then UPDATE returns 409', () =>
    setupPipeline().then(({ apiHandler, wrappedEventStore }) => {
      const createRes = mockRes();
      return apiHandler(
        mockReq({
          command: 'CREATE',
          aggregateName: 'customer',
          aggregateId: 'cust-mixin-2',
          payload: { name: 'Charlie' },
          correlationId: 'corr-create-2',
        }),
        createRes,
      )
        .then(() => {
          expect(createRes.sendStatus).toHaveBeenCalledWith(200);
        })
        .then(() => {
          const forgetRes = mockRes();
          return apiHandler(
            mockReq({
              command: 'FORGET_SUBJECT',
              aggregateName: 'customer',
              aggregateId: 'cust-mixin-2',
              payload: {
                subjectId: 'cust-mixin-2',
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
          // Fresh aggregate store — simulates restart
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

          const updateRes = mockRes();
          return freshApiHandler(
            mockReq({
              command: 'UPDATE',
              aggregateName: 'customer',
              aggregateId: 'cust-mixin-2',
              payload: { name: 'Charlie Brown' },
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
    }));
});
