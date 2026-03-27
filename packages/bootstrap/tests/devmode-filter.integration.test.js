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
const { createRoutes } = await import('@lazyapps/admin-api/routes.js');
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
        developmentMode: true,
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

  // 11.5: changeNotification suppressed during replay (explicit assertion)
  test('11.5: changeNotification.sendChangeNotification NOT called during replay', () => {
    const changeNotificationCalls = [];
    registerSharedMqEmitter('filter-notif-replay-events', mqemitter());
    registerSharedMqEmitter('filter-notif-replay-queries', mqemitter());

    return initializeContext(
      { serviceId: 'filter-notif-replay' },
      {
        readModels: {
          items: {
            projections: {
              ITEM_CREATED: (ctx, event) =>
                ctx.storage
                  .insertOne('items_overview', {
                    id: event.aggregateId,
                    name: event.payload.name,
                  })
                  .then(() =>
                    ctx.changeNotification.sendChangeNotification({
                      readModel: 'items',
                      type: 'ITEM_CREATED',
                    }),
                  ),
            },
            collections: ['items_overview'],
            replayRelevantEvents: ['ITEM_CREATED'],
          },
        },
        endpointName: 'ep',
        storage: readModelStorageMongo({
          url: connectionString,
          database: 'filter-notif-replay',
        }),
        eventBus: readModelEventBusMqEmitter({
          mqName: 'filter-notif-replay-events',
        }),
        changeNotificationSender: {
          sendChangeNotification: (correlationId, notification) => {
            changeNotificationCalls.push(notification);
            return Promise.resolve();
          },
        },
        commandSender: {
          sendCommand: () => () => Promise.resolve(),
        },
        developmentMode: true,
      },
    ).then((context) => {
      const projHandler = context.projectionHandler;
      return projHandler
        .projectEventForReadModel(
          'corr-notif',
          'items',
        )(makeEvent(1, 100))
        .then(() => flush())
        .then(() => {
          // changeNotification.sendChangeNotification should NOT have been
          // called because projectEventForReadModel sets inReplay=true,
          // which replaces sendChangeNotification with a no-op
          expect(changeNotificationCalls).toHaveLength(0);
        });
    });
  });

  // 12.15: setSideEffectFilter rejected when developmentMode=false
  test('12.15: setSideEffectFilter rejected when developmentMode=false', () => {
    registerSharedMqEmitter('filter-guard-prod-events', mqemitter());

    return initializeContext(
      { serviceId: 'filter-guard-prod' },
      {
        readModels: {
          items: {
            projections: {
              ITEM_CREATED: (ctx, event) =>
                ctx.storage.insertOne('items_data', {
                  id: event.aggregateId,
                }),
            },
            collections: ['items_data'],
          },
        },
        endpointName: 'ep',
        storage: readModelStorageMongo({
          url: connectionString,
          database: 'filter-guard-prod',
        }),
        eventBus: readModelEventBusMqEmitter({
          mqName: 'filter-guard-prod-events',
        }),
        changeNotificationSender: {
          sendChangeNotification: () => () => Promise.resolve(),
        },
        commandSender: {
          sendCommand: () => () => Promise.resolve(),
        },
        developmentMode: false,
      },
    ).then((context) => {
      getLogger().error.mockClear();

      context.projectionHandler.setSideEffectFilter('items', {
        byName: { type: 'include', names: ['sendEmail'] },
      });

      // Should have logged a REJECTED error
      expect(getLogger().error).toHaveBeenCalledWith(
        expect.stringContaining('REJECTED'),
      );

      // Filter should NOT be stored
      const filter = context.projectionHandler.getSideEffectFilter('items');
      expect(filter).toBeNull();
    });
  });

  // 12.15 (positive): setSideEffectFilter accepted when developmentMode=true
  test('12.15: setSideEffectFilter accepted when developmentMode=true', () => {
    registerSharedMqEmitter('filter-guard-dev-events', mqemitter());

    return initializeContext(
      { serviceId: 'filter-guard-dev' },
      {
        readModels: {
          items: {
            projections: {
              ITEM_CREATED: (ctx, event) =>
                ctx.storage.insertOne('items_data', {
                  id: event.aggregateId,
                }),
            },
            collections: ['items_data'],
          },
        },
        endpointName: 'ep',
        storage: readModelStorageMongo({
          url: connectionString,
          database: 'filter-guard-dev',
        }),
        eventBus: readModelEventBusMqEmitter({
          mqName: 'filter-guard-dev-events',
        }),
        changeNotificationSender: {
          sendChangeNotification: () => () => Promise.resolve(),
        },
        commandSender: {
          sendCommand: () => () => Promise.resolve(),
        },
        developmentMode: true,
      },
    ).then((context) => {
      getLogger().error.mockClear();

      context.projectionHandler.setSideEffectFilter('items', {
        byName: { type: 'include', names: ['sendEmail'] },
      });

      // Should NOT have logged a rejection
      expect(getLogger().error).not.toHaveBeenCalledWith(
        expect.stringContaining('REJECTED'),
      );

      // Filter should be stored
      const filter = context.projectionHandler.getSideEffectFilter('items');
      expect(filter).toEqual({
        byName: { type: 'include', names: ['sendEmail'] },
      });
    });
  });
});

// ── 10: dismissInvalid + skipCatchup tests ────────────────────────────

describe('10: dismissInvalid and skipCatchup', { timeout: 30000 }, () => {
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

  const createDevModeRmContext = (prefix, devMode) => {
    registerSharedMqEmitter(`dismiss-${prefix}-events`, mqemitter());

    return startReadModels(
      { serviceId: `dismiss-${prefix}` },
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
          database: `dismiss-${prefix}`,
        }),
        eventBus: readModelEventBusMqEmitter({
          mqName: `dismiss-${prefix}-events`,
        }),
        changeNotificationSender: {
          sendChangeNotification: () => () => Promise.resolve(),
        },
        commandSender: {
          sendCommand: () => () => Promise.resolve(),
        },
        developmentMode: devMode,
        lifecycle: true,
        listener: (ctx) => ctx,
      },
    );
  };

  // 10.3: dismissInvalid in dev mode transitions invalid → stopped
  test('10.3: dismissInvalid transitions invalid→stopped in dev mode', () =>
    createDevModeRmContext('dismiss-dev', true)
      .then((context) => {
        // Force the RM into invalid state by setting replayInProgress in MongoDB
        // then re-initializing the lifecycle manager
        return cleanupClient
          .db('dismiss-dismiss-dev')
          .collection('readmodel.state')
          .updateOne(
            { name: 'myRM' },
            { $set: { replayInProgress: true } },
            { upsert: true },
          )
          .then(() => context.lifecycleManager.initialize(['myRM']))
          .then(() => ({ context }));
      })
      .then(({ context }) => {
        // Verify RM is in invalid state
        expect(context.lifecycleManager.getState('myRM')).toBe('invalid');

        // Send dismissInvalid instruction
        context.adminInstructionHandler('corr-dismiss-dev', {
          type: 'dismissInvalid',
          targetReadModel: 'myRM',
          developmentOperation: true,
        });

        // Should transition to stopped
        expect(context.lifecycleManager.getState('myRM')).toBe('idle');
      }));

  // 10.5: dismissInvalid rejected in prod mode
  test('10.5: dismissInvalid rejected when developmentMode=false', () =>
    createDevModeRmContext('dismiss-prod', false).then((context) => {
      getLogger().error.mockClear();

      // Send dismissInvalid with developmentOperation flag
      context.adminInstructionHandler('corr-dismiss-prod', {
        type: 'dismissInvalid',
        targetReadModel: 'myRM',
        developmentOperation: true,
      });

      // Should have logged a REJECTED error
      expect(getLogger().error).toHaveBeenCalledWith(
        expect.stringContaining('REJECTED'),
      );
    }));

  // 10.1: activate with skipCatchup goes directly to live (dev mode)
  // This tests the RM instruction handler level: activate → catchup,
  // then catchupDone immediately (simulating what the orchestrator does
  // when skipCatchup=true)
  test('10.1: activate + immediate catchupDone skips catch-up flow', () =>
    createDevModeRmContext('skip-catchup', true).then((context) => {
      // Activate the RM — puts it in catchup state
      return context.lifecycleManager
        .activate('myRM', 'corr-skip')
        .then(() => {
          expect(context.lifecycleManager.getState('myRM')).toBe('catchup');

          // Immediately send catchupDone (what orchestrator does with skipCatchup)
          return context.lifecycleManager.catchupDone('myRM', 0, 'corr-skip');
        })
        .then(() => {
          expect(context.lifecycleManager.getState('myRM')).toBe('live');
        });
    }));

  // 10.4: Dismiss invalid + activate with catch-up (full sequence)
  test('10.4: dismiss invalid → stopped → activate with catch-up → live', () =>
    createDevModeRmContext('dismiss-activate', true)
      .then((context) =>
        // Force RM into invalid state
        cleanupClient
          .db('dismiss-dismiss-activate')
          .collection('readmodel.state')
          .updateOne(
            { name: 'myRM' },
            { $set: { replayInProgress: true } },
            { upsert: true },
          )
          .then(() => context.lifecycleManager.initialize(['myRM']))
          .then(() => context),
      )
      .then((context) => {
        // Verify invalid state
        expect(context.lifecycleManager.getState('myRM')).toBe('invalid');

        // Dismiss invalid → stopped
        context.adminInstructionHandler('corr-dismiss-act', {
          type: 'dismissInvalid',
          targetReadModel: 'myRM',
          developmentOperation: true,
        });
        expect(context.lifecycleManager.getState('myRM')).toBe('idle');

        // Activate with catch-up (normal activate) → catchup → catchupDone → live
        return context.lifecycleManager
          .activate('myRM', 'corr-act')
          .then(() => {
            expect(context.lifecycleManager.getState('myRM')).toBe('catchup');
            return context.lifecycleManager.catchupDone('myRM', 0, 'corr-act');
          })
          .then(() => {
            expect(context.lifecycleManager.getState('myRM')).toBe('live');
          });
      }));

  // 10.5: Dismiss invalid + activate without catch-up (full sequence)
  test('10.5: dismiss invalid → stopped → activate with skipCatchup → live', () =>
    createDevModeRmContext('dismiss-skip', true)
      .then((context) =>
        // Force RM into invalid state
        cleanupClient
          .db('dismiss-dismiss-skip')
          .collection('readmodel.state')
          .updateOne(
            { name: 'myRM' },
            { $set: { replayInProgress: true } },
            { upsert: true },
          )
          .then(() => context.lifecycleManager.initialize(['myRM']))
          .then(() => context),
      )
      .then((context) => {
        // Verify invalid state
        expect(context.lifecycleManager.getState('myRM')).toBe('invalid');

        // Dismiss invalid → stopped
        context.adminInstructionHandler('corr-dismiss-skip', {
          type: 'dismissInvalid',
          targetReadModel: 'myRM',
          developmentOperation: true,
        });
        expect(context.lifecycleManager.getState('myRM')).toBe('idle');

        // Activate → catchup, then immediate catchupDone (skipCatchup)
        return context.lifecycleManager
          .activate('myRM', 'corr-skip-act')
          .then(() => {
            expect(context.lifecycleManager.getState('myRM')).toBe('catchup');
            return context.lifecycleManager.catchupDone(
              'myRM',
              0,
              'corr-skip-act',
            );
          })
          .then(() => {
            expect(context.lifecycleManager.getState('myRM')).toBe('live');
          });
      }));
});

// ── 9.1: developmentMode flag threading ───────────────────────────────

describe('9.1: developmentMode flag threading', { timeout: 30000 }, () => {
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

  test('developmentMode=true is accessible in RM context and enables dev features', () =>
    startReadModels(
      { serviceId: 'thread-dev' },
      {
        readModels: {
          myRM: { projections: {} },
        },
        storage: readModelStorageMongo({
          url: connectionString,
          database: 'devmode-thread-dev',
        }),
        eventBus: readModelEventBusMqEmitter({
          mqName: (() => {
            registerSharedMqEmitter('thread-dev-events', mqemitter());
            return 'thread-dev-events';
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
      // Verify the flag is threaded through to the context
      expect(context.developmentMode).toBe(true);

      // Verify dev operations are accepted (no REJECTED error)
      getLogger().error.mockClear();
      context.adminInstructionHandler('corr-thread', {
        type: 'persistTimestamp',
        targetReadModel: 'myRM',
        timestamp: 100,
        developmentOperation: true,
      });
      expect(getLogger().error).not.toHaveBeenCalledWith(
        expect.stringContaining('REJECTED'),
      );
    }));

  test('developmentMode defaults to false when absent and blocks dev features', () =>
    startReadModels(
      { serviceId: 'thread-nodev' },
      {
        readModels: {
          myRM: { projections: {} },
        },
        storage: readModelStorageMongo({
          url: connectionString,
          database: 'devmode-thread-nodev',
        }),
        eventBus: readModelEventBusMqEmitter({
          mqName: (() => {
            registerSharedMqEmitter('thread-nodev-events', mqemitter());
            return 'thread-nodev-events';
          })(),
        }),
        changeNotificationSender: {
          sendChangeNotification: () => () => Promise.resolve(),
        },
        commandSender: {
          sendCommand: () => () => Promise.resolve(),
        },
        listener: (ctx) => ctx,
        // No developmentMode — defaults to false
      },
    ).then((context) => {
      // Verify the flag defaults to falsy
      expect(context.developmentMode).toBeFalsy();

      // Verify dev operations are rejected
      getLogger().error.mockClear();
      context.adminInstructionHandler('corr-nodev', {
        type: 'persistTimestamp',
        targetReadModel: 'myRM',
        timestamp: 100,
        developmentOperation: true,
      });
      expect(getLogger().error).toHaveBeenCalledWith(
        expect.stringContaining('REJECTED'),
      );
    }));
});

// ── 10.2: skipCatchup rejected in production mode ─────────────────────

describe('10.2: skipCatchup in production mode', { timeout: 30000 }, () => {
  test('skipCatchup rejected when developmentMode=false', () => {
    const sseClient = {
      cache: {
        getAllReadModels: vi.fn().mockReturnValue({
          'ep/myRM': { state: 'idle' },
        }),
        getReadModel: vi.fn().mockReturnValue({ state: 'idle' }),
      },
    };
    const orchestrator = {
      activationOrchestration: vi.fn().mockResolvedValue({ status: 'live' }),
    };
    const eventBus = {
      publishAdminInstruction: vi.fn().mockReturnValue(vi.fn()),
    };

    const routes = createRoutes({
      sseClient,
      orchestrator,
      eventBus,
      developmentMode: false,
    });

    const req = {
      params: { ep: 'ep', rm: 'myRM' },
      body: { skipCatchup: true },
    };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };

    routes.activateRm(req, res);

    // skipCatchup should be rejected in production mode
    expect(res.status).toHaveBeenCalledWith(403);
    expect(orchestrator.activationOrchestration).not.toHaveBeenCalled();
  });

  test('skipCatchup accepted when developmentMode=true', () => {
    const sseClient = {
      cache: {
        getAllReadModels: vi.fn().mockReturnValue({
          'ep/myRM': { state: 'idle' },
        }),
        getReadModel: vi.fn().mockReturnValue({ state: 'idle' }),
      },
    };
    const orchestrator = {
      activationOrchestration: vi.fn().mockResolvedValue({ status: 'live' }),
    };
    const eventBus = {
      publishAdminInstruction: vi.fn().mockReturnValue(vi.fn()),
    };

    const routes = createRoutes({
      sseClient,
      orchestrator,
      eventBus,
      developmentMode: true,
    });

    const req = {
      params: { ep: 'ep', rm: 'myRM' },
      body: { skipCatchup: true },
    };
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };

    routes.activateRm(req, res);

    expect(res.status).toHaveBeenCalledWith(202);
    expect(orchestrator.activationOrchestration).toHaveBeenCalledWith(
      'ep',
      'myRM',
      { skipCatchup: true },
    );
  });
});

// ── 11.2 & 11.4: side-effect options rejected in production mode ──────

describe(
  '11.2 & 11.4: side-effect options rejected in production mode',
  { timeout: 30000 },
  () => {
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

    const setupFilterEnvWithDevMode = (prefix, devMode) => {
      registerSharedMqEmitter(`se-guard-${prefix}-events`, mqemitter());

      return initializeContext(
        { serviceId: `se-guard-${prefix}` },
        {
          readModels: {
            items: {
              projections: {
                ITEM_CREATED: (ctx, event) =>
                  ctx.storage.insertOne('items_data', {
                    id: event.aggregateId,
                  }),
              },
              collections: ['items_data'],
            },
          },
          endpointName: 'ep',
          storage: readModelStorageMongo({
            url: connectionString,
            database: `se-guard-${prefix}`,
          }),
          eventBus: readModelEventBusMqEmitter({
            mqName: `se-guard-${prefix}-events`,
          }),
          changeNotificationSender: {
            sendChangeNotification: () => () => Promise.resolve(),
          },
          commandSender: {
            sendCommand: () => () => Promise.resolve(),
          },
          developmentMode: devMode,
        },
      ).then((context) => ({
        context,
        projHandler: context.projectionHandler,
      }));
    };

    test('11.2: enableSideEffects rejected when developmentMode=false', () =>
      setupFilterEnvWithDevMode('enable-prod', false).then(
        ({ projHandler }) => {
          getLogger().error.mockClear();

          // Attempt to set enableSideEffects in production mode
          projHandler.setReplayOptions('items', {
            enableSideEffects: true,
          });

          // Should have logged a rejection warning
          expect(getLogger().error).toHaveBeenCalledWith(
            expect.stringContaining('REJECTED'),
          );

          // Option should NOT be stored
          const opts = projHandler.getReplayOptions('items');
          expect(opts?.enableSideEffects).toBeFalsy();
        },
      ));

    test('11.2: enableSideEffects accepted when developmentMode=true', () =>
      setupFilterEnvWithDevMode('enable-dev', true).then(({ projHandler }) => {
        getLogger().error.mockClear();

        projHandler.setReplayOptions('items', {
          enableSideEffects: true,
        });

        // Should NOT have logged a rejection
        expect(getLogger().error).not.toHaveBeenCalledWith(
          expect.stringContaining('REJECTED'),
        );

        // Option should be stored
        const opts = projHandler.getReplayOptions('items');
        expect(opts.enableSideEffects).toBe(true);
      }));

    test('11.4: suppressSideEffects rejected when developmentMode=false', () =>
      setupFilterEnvWithDevMode('suppress-prod', false).then(
        ({ projHandler }) => {
          getLogger().error.mockClear();

          projHandler.setReplayOptions('items', {
            suppressSideEffects: true,
          });

          // Should have logged a rejection warning
          expect(getLogger().error).toHaveBeenCalledWith(
            expect.stringContaining('REJECTED'),
          );

          // Option should NOT be stored
          const opts = projHandler.getReplayOptions('items');
          expect(opts?.suppressSideEffects).toBeFalsy();
        },
      ));

    test('11.4: suppressSideEffects accepted when developmentMode=true', () =>
      setupFilterEnvWithDevMode('suppress-dev', true).then(
        ({ projHandler }) => {
          getLogger().error.mockClear();

          projHandler.setReplayOptions('items', {
            suppressSideEffects: true,
          });

          // Should NOT have logged a rejection
          expect(getLogger().error).not.toHaveBeenCalledWith(
            expect.stringContaining('REJECTED'),
          );

          // Option should be stored
          const opts = projHandler.getReplayOptions('items');
          expect(opts.suppressSideEffects).toBe(true);
        },
      ));
  },
);
