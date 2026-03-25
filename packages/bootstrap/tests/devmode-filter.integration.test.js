import { describe, test, expect, vi, beforeAll, afterAll } from 'vitest';
import { MongoDBContainer } from '@testcontainers/mongodb';
import { MongoClient } from 'mongodb';
import expressApp from 'express';
import bodyParser from 'body-parser';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debugBare: vi.fn(),
  }),
  getStream: vi.fn().mockReturnValue({ write: vi.fn() }),
}));

const { getLogger } = await import('@lazyapps/logger');

const mqemitter = (await import('mqemitter')).default;
const { registerSharedMqEmitter, getSharedMqEmitter } =
  await import('@lazyapps/mqemitter');
const { mongodb: readModelStorageMongo } =
  await import('@lazyapps/readmodelstorage-mongodb');
const { readModelEventBusMqEmitter, readModelListenerMqEmitter } =
  await import('@lazyapps/mqemitter');
const { initializeContext } = await import('@lazyapps/readmodels/context.js');
const { startReadModels, installAdminEndpoints } =
  await import('@lazyapps/readmodels');
const { installReadModelStatusApi } = await import('@lazyapps/admin-api');
const { createProjectionHandler } =
  await import('@lazyapps/readmodels/projections.js');

const waitForCondition = (fn, timeout = 5000, interval = 100) => {
  const start = Date.now();
  const poll = () =>
    Promise.resolve()
      .then(fn)
      .then((result) => {
        if (result) return;
        if (Date.now() - start > timeout)
          throw new Error('Timeout waiting for condition');
        return new Promise((r) => setTimeout(r, interval)).then(poll);
      });
  return poll();
};

const flush = () =>
  new Promise((resolve) => {
    setTimeout(resolve, 50);
  });

// ── C6: Dev-mode gatekeeping tests ─────────────────────────────────────

describe('C6: developmentOperation gatekeeping', { timeout: 30000 }, () => {
  let container;
  let connectionString;
  let cleanupClient;

  beforeAll(() =>
    new MongoDBContainer('mongo:7')
      .start()
      .then((c) => {
        container = c;
        connectionString = c.getConnectionString() + '?directConnection=true';
        return MongoClient.connect(connectionString);
      })
      .then((client) => {
        cleanupClient = client;
      }),
  );

  afterAll(() =>
    Promise.resolve()
      .then(() => (cleanupClient ? cleanupClient.close() : undefined))
      .then(() => (container ? container.stop() : undefined)),
  );

  const createRmContext = (opts = {}) => {
    registerSharedMqEmitter(
      `devmode-${opts.prefix || 'test'}-events`,
      mqemitter(),
    );

    return initializeContext(
      { serviceId: `devmode-${opts.prefix || 'test'}` },
      {
        readModels: {
          myRM: {
            projections: {
              EV: ({ storage }, event) =>
                storage.insertOne('myRM_data', {
                  id: event.aggregateId,
                }),
            },
            collections: ['myRM_data'],
          },
        },
        endpointName: 'ep',
        storage: readModelStorageMongo({
          url: connectionString,
          database: `devmode-${opts.prefix || 'test'}`,
        }),
        eventBus: readModelEventBusMqEmitter({
          mqName: `devmode-${opts.prefix || 'test'}-events`,
        }),
        changeNotificationSender: {
          sendChangeNotification: () => () => Promise.resolve(),
        },
        commandSender: {
          sendCommand: () => () => Promise.resolve(),
        },
        developmentMode: opts.developmentMode || false,
        lifecycle: !!opts.lifecycle,
      },
    );
  };

  test('rejects developmentOperation when developmentMode=false', () =>
    startReadModels(
      { serviceId: 'reject-test' },
      {
        readModels: {
          myRM: { projections: {} },
        },
        storage: readModelStorageMongo({
          url: connectionString,
          database: 'devmode-reject',
        }),
        eventBus: readModelEventBusMqEmitter({
          mqName: (() => {
            registerSharedMqEmitter('reject-events', mqemitter());
            return 'reject-events';
          })(),
        }),
        changeNotificationSender: {
          sendChangeNotification: () => () => Promise.resolve(),
        },
        commandSender: {
          sendCommand: () => () => Promise.resolve(),
        },
        listener: (ctx) => ctx,
        // No developmentMode → defaults to false
      },
    ).then((context) => {
      // Clear any prior logger calls
      getLogger().error.mockClear();

      context.adminInstructionHandler('corr-reject', {
        type: 'stop',
        targetReadModel: 'myRM',
        developmentOperation: true,
      });

      // Should have logged a REJECTED error
      expect(getLogger().error).toHaveBeenCalledWith(
        expect.stringContaining('REJECTED'),
      );
    }));

  test('accepts developmentOperation when developmentMode=true', () =>
    startReadModels(
      { serviceId: 'accept-test' },
      {
        readModels: {
          myRM: { projections: {} },
        },
        storage: readModelStorageMongo({
          url: connectionString,
          database: 'devmode-accept',
        }),
        eventBus: readModelEventBusMqEmitter({
          mqName: (() => {
            registerSharedMqEmitter('accept-events', mqemitter());
            return 'accept-events';
          })(),
        }),
        changeNotificationSender: {
          sendChangeNotification: () => () => Promise.resolve(),
        },
        commandSender: {
          sendCommand: () => () => Promise.resolve(),
        },
        listener: (ctx) => ctx,
        developmentMode: true,
      },
    ).then((context) => {
      getLogger().error.mockClear();

      // persistTimestamp with developmentOperation should be accepted
      context.adminInstructionHandler('corr-accept', {
        type: 'persistTimestamp',
        targetReadModel: 'myRM',
        timestamp: 12345,
        developmentOperation: true,
      });

      // Should NOT have logged a REJECTED error
      expect(getLogger().error).not.toHaveBeenCalledWith(
        expect.stringContaining('REJECTED'),
      );
    }));

  test('normal instructions work without developmentMode', () =>
    startReadModels(
      { serviceId: 'normal-test' },
      {
        readModels: {
          myRM: { projections: {} },
        },
        storage: readModelStorageMongo({
          url: connectionString,
          database: 'devmode-normal',
        }),
        eventBus: readModelEventBusMqEmitter({
          mqName: (() => {
            registerSharedMqEmitter('normal-events', mqemitter());
            return 'normal-events';
          })(),
        }),
        changeNotificationSender: {
          sendChangeNotification: () => () => Promise.resolve(),
        },
        commandSender: {
          sendCommand: () => () => Promise.resolve(),
        },
        listener: (ctx) => ctx,
      },
    ).then((context) => {
      getLogger().error.mockClear();

      // Normal instruction (no developmentOperation flag)
      context.adminInstructionHandler('corr-normal', {
        type: 'persistTimestamp',
        targetReadModel: 'myRM',
        timestamp: 999,
      });

      // Should NOT have logged any rejection
      expect(getLogger().error).not.toHaveBeenCalledWith(
        expect.stringContaining('REJECTED'),
      );
    }));

  test('persistTimestamp writes to real MongoDB storage', () =>
    startReadModels(
      { serviceId: 'persist-test' },
      {
        readModels: {
          myRM: { projections: {}, lastProjectedEventTimestamp: 0 },
        },
        storage: readModelStorageMongo({
          url: connectionString,
          database: 'devmode-persist',
        }),
        eventBus: readModelEventBusMqEmitter({
          mqName: (() => {
            registerSharedMqEmitter('persist-events', mqemitter());
            return 'persist-events';
          })(),
        }),
        changeNotificationSender: {
          sendChangeNotification: () => () => Promise.resolve(),
        },
        commandSender: {
          sendCommand: () => () => Promise.resolve(),
        },
        listener: (ctx) => ctx,
      },
    )
      .then((context) => {
        context.adminInstructionHandler('corr-persist', {
          type: 'persistTimestamp',
          targetReadModel: 'myRM',
          timestamp: 42000,
        });
        return flush().then(() => context);
      })
      .then((context) => {
        // Verify in-memory update
        expect(context.readModels.myRM.lastProjectedEventTimestamp).toBe(42000);
        // Verify MongoDB update
        return cleanupClient
          .db('devmode-persist')
          .collection('readmodel.state')
          .findOne({ name: 'myRM' });
      })
      .then((doc) => {
        expect(doc.lastProjectedEventTimestamp).toBe(42000);
      }));
});

// ── D6: Side-effect filter tests ───────────────────────────────────────

describe('D6: side-effect filter in projections', { timeout: 30000 }, () => {
  let container;
  let connectionString;
  let cleanupClient;

  beforeAll(() =>
    new MongoDBContainer('mongo:7')
      .start()
      .then((c) => {
        container = c;
        connectionString = c.getConnectionString() + '?directConnection=true';
        return MongoClient.connect(connectionString);
      })
      .then((client) => {
        cleanupClient = client;
      }),
  );

  afterAll(() =>
    Promise.resolve()
      .then(() => (cleanupClient ? cleanupClient.close() : undefined))
      .then(() => (container ? container.stop() : undefined)),
  );

  // Track side-effect and command execution
  const createTrackingReadModels = (tracker) => ({
    items: {
      projections: {
        ITEM_CREATED: (ctx, event) =>
          ctx.storage
            .insertOne('items_overview', {
              id: event.aggregateId,
              name: event.payload.name,
            })
            .then(() =>
              ctx.sideEffects.schedule(
                () => {
                  tracker.sideEffects.push({
                    name: 'sendEmail',
                    eventId: event.aggregateId,
                  });
                  return Promise.resolve();
                },
                { name: 'sendEmail' },
              ),
            )
            .then(() =>
              ctx.sideEffects.schedule(
                () => {
                  tracker.sideEffects.push({
                    name: 'sendWebhook',
                    eventId: event.aggregateId,
                  });
                  return Promise.resolve();
                },
                { name: 'sendWebhook' },
              ),
            )
            .then(() => {
              const cmdThunk = ctx.commands.execute({
                type: 'NOTIFY_CREATED',
                aggregateId: event.aggregateId,
              });
              return cmdThunk();
            })
            .then(() => {
              tracker.commands.push({
                type: 'NOTIFY_CREATED',
                eventId: event.aggregateId,
              });
            }),
      },
      collections: ['items_overview'],
      replayRelevantEvents: ['ITEM_CREATED'],
    },
  });

  const setupFilterEnv = (prefix) => {
    const tracker = { sideEffects: [], commands: [] };
    const readModels = createTrackingReadModels(tracker);

    registerSharedMqEmitter(`filter-${prefix}-events`, mqemitter());
    registerSharedMqEmitter(`filter-${prefix}-queries`, mqemitter());

    const commandsSent = [];
    return initializeContext(
      { serviceId: `filter-${prefix}` },
      {
        readModels,
        endpointName: 'ep',
        storage: readModelStorageMongo({
          url: connectionString,
          database: `filter-${prefix}`,
        }),
        eventBus: readModelEventBusMqEmitter({
          mqName: `filter-${prefix}-events`,
        }),
        changeNotificationSender: {
          sendChangeNotification: () => () => Promise.resolve(),
        },
        commandSender: {
          sendCommand: (correlationId, cmd) => {
            commandsSent.push(cmd);
            return Promise.resolve();
          },
        },
      },
    ).then((context) => ({
      context,
      tracker,
      commandsSent,
      projHandler: context.projectionHandler,
    }));
  };

  const makeEvent = (id, ts) => ({
    type: 'ITEM_CREATED',
    aggregateId: `item-${id}`,
    timestamp: ts,
    payload: { name: `Item ${id}` },
  });

  test('IncludeByName filter: only named side-effects run during replay', () =>
    setupFilterEnv('include-name').then(({ projHandler, tracker }) => {
      projHandler.setSideEffectFilter('items', {
        byName: { type: 'include', names: ['sendEmail'] },
      });

      return projHandler
        .projectEventForReadModel(
          'corr-1',
          'items',
        )(makeEvent(1, 100))
        .then(() => flush())
        .then(() => {
          // Only sendEmail should have run
          const names = tracker.sideEffects.map((s) => s.name);
          expect(names).toContain('sendEmail');
          expect(names).not.toContain('sendWebhook');
        });
    }));

  test('ExcludeByName filter: all except named run during replay', () =>
    setupFilterEnv('exclude-name').then(({ projHandler, tracker }) => {
      projHandler.setSideEffectFilter('items', {
        byName: { type: 'exclude', names: ['sendWebhook'] },
      });

      return projHandler
        .projectEventForReadModel(
          'corr-1',
          'items',
        )(makeEvent(1, 100))
        .then(() => flush())
        .then(() => {
          const names = tracker.sideEffects.map((s) => s.name);
          expect(names).toContain('sendEmail');
          expect(names).not.toContain('sendWebhook');
        });
    }));

  test('IncludeCommand filter: only named commands sent during replay', () =>
    setupFilterEnv('include-cmd').then(({ projHandler, commandsSent }) => {
      projHandler.setSideEffectFilter('items', {
        byCommand: {
          type: 'include',
          commands: ['NOTIFY_CREATED'],
        },
      });

      return projHandler
        .projectEventForReadModel(
          'corr-1',
          'items',
        )(makeEvent(1, 100))
        .then(() => flush())
        .then(() => {
          // Command should have been sent (filter allows it)
          expect(commandsSent).toHaveLength(1);
          expect(commandsSent[0].type).toBe('NOTIFY_CREATED');
        });
    }));

  test('ExcludeCommand filter: all except named sent during replay', () =>
    setupFilterEnv('exclude-cmd').then(({ projHandler, commandsSent }) => {
      projHandler.setSideEffectFilter('items', {
        byCommand: {
          type: 'exclude',
          commands: ['NOTIFY_CREATED'],
        },
      });

      return projHandler
        .projectEventForReadModel(
          'corr-1',
          'items',
        )(makeEvent(1, 100))
        .then(() => flush())
        .then(() => {
          // Command should NOT have been sent (filtered out)
          expect(commandsSent).toHaveLength(0);
        });
    }));

  test('combined ByName + ByCommand filter during replay', () =>
    setupFilterEnv('combined').then(
      ({ projHandler, tracker, commandsSent }) => {
        projHandler.setSideEffectFilter('items', {
          byName: { type: 'include', names: ['sendEmail'] },
          byCommand: {
            type: 'exclude',
            commands: ['NOTIFY_CREATED'],
          },
        });

        return projHandler
          .projectEventForReadModel(
            'corr-1',
            'items',
          )(makeEvent(1, 100))
          .then(() => flush())
          .then(() => {
            // sendEmail runs, sendWebhook doesn't
            const names = tracker.sideEffects.map((s) => s.name);
            expect(names).toContain('sendEmail');
            expect(names).not.toContain('sendWebhook');
            // Command excluded
            expect(commandsSent).toHaveLength(0);
          });
      },
    ));

  test('enableSideEffects: all side-effects run during replay', () =>
    setupFilterEnv('enable-all').then(
      ({ projHandler, tracker, commandsSent }) => {
        projHandler.setReplayOptions('items', {
          enableSideEffects: true,
        });

        return projHandler
          .projectEventForReadModel(
            'corr-1',
            'items',
          )(makeEvent(1, 100))
          .then(() => flush())
          .then(() => {
            // Both side-effects should run
            const names = tracker.sideEffects.map((s) => s.name);
            expect(names).toContain('sendEmail');
            expect(names).toContain('sendWebhook');
            // Command should also run (un-stubbed)
            expect(commandsSent).toHaveLength(1);
          });
      },
    ));

  test('no filter: commands and side-effects stubbed during replay', () =>
    setupFilterEnv('no-filter').then(({ projHandler, tracker, commandsSent }) =>
      // No filter, no enableSideEffects — default replay behavior
      projHandler
        .projectEventForReadModel(
          'corr-1',
          'items',
        )(makeEvent(1, 100))
        .then(() => flush())
        .then(() => {
          // Side-effects should be skipped (inReplay=true)
          expect(tracker.sideEffects).toHaveLength(0);
          // Commands should be stubbed
          expect(commandsSent).toHaveLength(0);
        }),
    ));

  test('suppressSideEffects: commands and side-effects stubbed during catch-up', () =>
    setupFilterEnv('suppress-catchup').then(
      ({ projHandler, tracker, commandsSent }) => {
        projHandler.setReplayOptions('items', {
          suppressSideEffects: true,
        });
        projHandler.setReadModelCatchingUp('items');

        return projHandler
          .projectCatchupEventForReadModel(
            'corr-1',
            'items',
          )(makeEvent(1, 100))
          .then(() => flush())
          .then(() => {
            // Side-effects should be skipped
            expect(tracker.sideEffects).toHaveLength(0);
            // Commands should be stubbed
            expect(commandsSent).toHaveLength(0);
          });
      },
    ));
});
