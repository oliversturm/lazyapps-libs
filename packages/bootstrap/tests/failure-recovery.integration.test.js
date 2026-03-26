import { describe, test, expect, vi, beforeAll, afterAll } from 'vitest';
import { MongoDBContainer } from '@testcontainers/mongodb';
import { MongoClient } from 'mongodb';
import expressApp from 'express';
import bodyParser from 'body-parser';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm as rmDir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

const mqemitter = (await import('mqemitter')).default;
const { registerSharedMqEmitter, getSharedMqEmitter } =
  await import('@lazyapps/mqemitter');
const { mongodb: eventStoreMongo } =
  await import('@lazyapps/eventstore-mongodb');
const { mongodb: readModelStorageMongo } =
  await import('@lazyapps/readmodelstorage-mongodb');
const {
  commandProcessorEventBusMqEmitter,
  readModelEventBusMqEmitter,
  readModelListenerMqEmitter,
} = await import('@lazyapps/mqemitter');
const { createCatchupHandler } =
  await import('@lazyapps/command-processor/catchupHandler.js');
const { createReplayHandler } =
  await import('@lazyapps/command-processor/replayHandler.js');
const { createCpStatusTracker } =
  await import('@lazyapps/command-processor/cpStatusTracker.js');
const { initializeContext } = await import('@lazyapps/readmodels/context.js');
const { installReadModelStatusApi } = await import('@lazyapps/admin-api');
const { installAdminEndpoints } = await import('@lazyapps/readmodels');
const { startAdmin } = await import('../admin.js');
const { backup: backupFactory } =
  await import('@lazyapps/readmodelstorage-mongodb/backup.js');

const hasMongoTools = (() => {
  try {
    execFileSync('mongoexport', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const createRmDef = (collectionName) => ({
  projections: {
    ITEM_CREATED: ({ storage }, event) =>
      storage.updateOne(
        collectionName,
        { id: event.aggregateId },
        {
          $set: {
            id: event.aggregateId,
            name: event.payload.name,
            ts: event.timestamp,
          },
        },
        { upsert: true },
      ),
  },
  resolvers: {
    all: (storage) =>
      storage.find(collectionName, {}).project({ _id: 0 }).toArray(),
  },
  collections: [collectionName],
  replayRelevantEvents: ['ITEM_CREATED'],
});

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

// Create a fresh RM context against existing MongoDB (simulates restart)
const createFreshContext = (prefix, connectionString, dbName, opts = {}) => {
  const mqEvName = `${prefix}-events`;
  const mqQName = `${prefix}-queries`;
  registerSharedMqEmitter(mqEvName, mqemitter());
  registerSharedMqEmitter(mqQName, mqemitter());

  return initializeContext(
    { serviceId: `${prefix}-RM` },
    {
      readModels: { items: createRmDef('items_overview') },
      endpointName: 'rm',
      storage: readModelStorageMongo({
        url: connectionString,
        database: dbName,
      }),
      eventBus: readModelEventBusMqEmitter({ mqName: mqEvName }),
      changeNotificationSender: {
        sendChangeNotification: () => () => Promise.resolve(),
      },
      commandSender: {
        sendCommand: () => () => Promise.resolve(),
      },
      lifecycle: true,
      ...opts,
    },
  );
};

// ── Category 6: RM dies mid-operation ─────────────────────────────────

describe('C6: RM dies mid-operation', { timeout: 60000 }, () => {
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

  // Helper: ensure readmodel.state doc exists (upsert) so lifecycle
  // operations like startReplay can set flags on it
  const ensureStateDoc = (dbName, rmName) =>
    cleanupClient
      .db(dbName)
      .collection('readmodel.state')
      .updateOne(
        { name: rmName },
        { $setOnInsert: { name: rmName, lastProjectedEventTimestamp: 0 } },
        { upsert: true },
      );

  // 6.1: RM dies during replay → restart → invalid state
  test('6.1: RM dies during replay — restart detects replayInProgress, enters invalid', () => {
    const dbName = 'c6-1-rm';
    return ensureStateDoc(dbName, 'items')
      .then(() => createFreshContext('c6-1-init', connectionString, dbName))
      .then((context) => {
        // Activate and go live so we have a baseline
        return context.lifecycleManager
          .activate('items', 'corr-init')
          .then(() =>
            context.lifecycleManager.catchupDone('items', 0, 'corr-init'),
          )
          .then(() => {
            // Now stop and start replay
            context.lifecycleManager.stop('items', 'corr-stop');
            return context.lifecycleManager.startReplay('items', 'corr-replay');
          })
          .then(() => {
            // Verify replayInProgress is set in MongoDB
            expect(context.lifecycleManager.getState('items')).toBe('replay');
            return cleanupClient
              .db(dbName)
              .collection('readmodel.state')
              .findOne({ name: 'items' });
          })
          .then((doc) => {
            expect(doc.replayInProgress).toBe(true);
            // "Kill" the context — don't call replayDone
            // (simulate RM process crash)
          });
      })
      .then(() =>
        // Restart: create a new context against the same MongoDB
        createFreshContext('c6-1-restart', connectionString, dbName),
      )
      .then((restartContext) => {
        // Lifecycle manager should detect replayInProgress and set invalid
        expect(restartContext.lifecycleManager.getState('items')).toBe(
          'invalid',
        );
      });
  });

  // 6.2: RM dies during catch-up → restart → resumes from timestamp
  test('6.2: RM dies during catch-up — restart resumes from lastProjectedEventTimestamp', () => {
    const dbName = 'c6-2-rm';
    return ensureStateDoc(dbName, 'items')
      .then(() => createFreshContext('c6-2-init', connectionString, dbName))
      .then((context) => {
        // Activate RM — enters catchup state
        return context.lifecycleManager
          .activate('items', 'corr-init')
          .then(() => {
            expect(context.lifecycleManager.getState('items')).toBe('catchup');

            // Simulate some events being projected during catch-up
            // by writing directly to MongoDB
            return cleanupClient
              .db(dbName)
              .collection('items_overview')
              .insertMany([
                { id: 'item-1', name: 'Item 1', ts: 1000 },
                { id: 'item-2', name: 'Item 2', ts: 2000 },
              ]);
          })
          .then(() =>
            // Update the timestamp to reflect partial catch-up (upsert)
            cleanupClient
              .db(dbName)
              .collection('readmodel.state')
              .updateOne(
                { name: 'items' },
                { $set: { lastProjectedEventTimestamp: 2000 } },
                { upsert: true },
              ),
          )
          .then(() => {
            // "Kill" the context mid-catch-up
            // No replayInProgress flag was set for catch-up
          });
      })
      .then(() =>
        // Restart: new context against same MongoDB
        createFreshContext('c6-2-restart', connectionString, dbName),
      )
      .then((restartContext) => {
        // Should NOT be invalid — catch-up doesn't set replayInProgress
        expect(restartContext.lifecycleManager.getState('items')).toBe(
          'stopped',
        );

        // The lastProjectedEventTimestamp should be at the point reached
        return cleanupClient
          .db(dbName)
          .collection('readmodel.state')
          .findOne({ name: 'items' });
      })
      .then((doc) => {
        expect(doc.lastProjectedEventTimestamp).toBe(2000);
        // Items projected so far should still be there
        return cleanupClient
          .db(dbName)
          .collection('items_overview')
          .countDocuments();
      })
      .then((count) => {
        expect(count).toBe(2);
      });
  });

  // 6.3: RM dies during backup restore → restart → invalid state
  test('6.3: RM dies during backup restore — restart detects replayInProgress, enters invalid', () => {
    const dbName = 'c6-3-rm';
    return createFreshContext('c6-3-init', connectionString, dbName)
      .then((context) => {
        // Set replayInProgress (as restoreBackup handler does before restore)
        return context.storage
          .perRequest('corr-restore')
          .updateOne(
            'readmodel.state',
            { name: 'items' },
            { $set: { replayInProgress: true } },
            { upsert: true },
          );
      })
      .then(() => {
        // "Kill" mid-restore — replayInProgress is left set
        // Restart
        return createFreshContext('c6-3-restart', connectionString, dbName);
      })
      .then((restartContext) => {
        expect(restartContext.lifecycleManager.getState('items')).toBe(
          'invalid',
        );
      });
  });

  // 6.4: RM dies during backup create → restart → invalid state
  test('6.4: RM dies during backup create — restart detects replayInProgress, enters invalid', () => {
    const dbName = 'c6-4-rm';
    return createFreshContext('c6-4-init', connectionString, dbName)
      .then((context) => {
        // createBackup sets replayInProgress before dump
        return context.storage
          .perRequest('corr-backup')
          .updateOne(
            'readmodel.state',
            { name: 'items' },
            { $set: { replayInProgress: true } },
            { upsert: true },
          );
      })
      .then(() => {
        // "Kill" mid-backup — replayInProgress left set
        return createFreshContext('c6-4-restart', connectionString, dbName);
      })
      .then((restartContext) => {
        expect(restartContext.lifecycleManager.getState('items')).toBe(
          'invalid',
        );
      });
  });
});

// ── Category 7: CP dies mid-operation ─────────────────────────────────

describe('C7: CP dies mid-replay', { timeout: 60000 }, () => {
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

  // Helper: ensure readmodel.state doc exists
  const ensureStateDoc = (dbName, rmName) =>
    cleanupClient
      .db(dbName)
      .collection('readmodel.state')
      .updateOne(
        { name: rmName },
        { $setOnInsert: { name: rmName, lastProjectedEventTimestamp: 0 } },
        { upsert: true },
      );

  // 7.2: CP dies while streaming replay events — RM stuck in replay,
  //      replayInProgress set, restart → invalid
  test('7.2: CP dies mid-replay stream — RM in replay state with replayInProgress, restart → invalid', () => {
    const dbName = 'c7-2-rm';
    return ensureStateDoc(dbName, 'items')
      .then(() => createFreshContext('c7-2-init', connectionString, dbName))
      .then((context) => {
        // Activate, go live, then stop to get ready for replay
        return context.lifecycleManager
          .activate('items', 'corr-init')
          .then(() =>
            context.lifecycleManager.catchupDone('items', 0, 'corr-init'),
          )
          .then(() => {
            context.lifecycleManager.stop('items', 'corr-stop');
            return context.lifecycleManager.startReplay('items', 'corr-replay');
          })
          .then(() => {
            expect(context.lifecycleManager.getState('items')).toBe('replay');

            // Simulate CP sending some replay events (project directly)
            return cleanupClient
              .db(dbName)
              .collection('items_overview')
              .insertMany([
                { id: 'r-item-1', name: 'Replayed 1', ts: 500 },
                { id: 'r-item-2', name: 'Replayed 2', ts: 1000 },
              ]);
          })
          .then(() => {
            // CP "dies" — stops sending events, never sends replayDone
            // RM is stuck in replay state with replayInProgress flag
            return cleanupClient
              .db(dbName)
              .collection('readmodel.state')
              .findOne({ name: 'items' });
          })
          .then((doc) => {
            expect(doc.replayInProgress).toBe(true);
            // "Kill" the RM context too
          });
      })
      .then(() =>
        // Restart RM
        createFreshContext('c7-2-restart', connectionString, dbName),
      )
      .then((restartContext) => {
        // Should detect replayInProgress → invalid
        expect(restartContext.lifecycleManager.getState('items')).toBe(
          'invalid',
        );

        // Partial replay data should still be in MongoDB
        return cleanupClient
          .db(dbName)
          .collection('items_overview')
          .countDocuments();
      })
      .then((count) => {
        expect(count).toBe(2);
      });
  });

  // 7.3: CP dies after sending all replay events but before replayDone —
  //      RM stuck in replay state, restart → invalid
  test('7.3: CP sends all replay events but no replayDone — RM in replay, restart → invalid', () => {
    const dbName = 'c7-3-rm';
    return ensureStateDoc(dbName, 'items')
      .then(() => createFreshContext('c7-3-init', connectionString, dbName))
      .then((context) => {
        // Activate, go live, stop, start replay
        return context.lifecycleManager
          .activate('items', 'corr-init')
          .then(() =>
            context.lifecycleManager.catchupDone('items', 0, 'corr-init'),
          )
          .then(() => {
            context.lifecycleManager.stop('items', 'corr-stop');
            return context.lifecycleManager.startReplay('items', 'corr-replay');
          })
          .then(() => {
            expect(context.lifecycleManager.getState('items')).toBe('replay');

            // All replay events have been projected (CP finished streaming)
            return cleanupClient
              .db(dbName)
              .collection('items_overview')
              .insertMany([
                { id: 'full-1', name: 'Full 1', ts: 100 },
                { id: 'full-2', name: 'Full 2', ts: 200 },
                { id: 'full-3', name: 'Full 3', ts: 300 },
              ]);
          })
          .then(() =>
            cleanupClient
              .db(dbName)
              .collection('readmodel.state')
              .updateOne(
                { name: 'items' },
                { $set: { lastProjectedEventTimestamp: 300 } },
              ),
          )
          .then(() => {
            // CP never sends replayDone — it crashed
            // replayDone would have called:
            //   lm.replayDone() → clears replayInProgress, sets stopped
            // But it didn't happen.
            return cleanupClient
              .db(dbName)
              .collection('readmodel.state')
              .findOne({ name: 'items' });
          })
          .then((doc) => {
            expect(doc.replayInProgress).toBe(true);
          });
      })
      .then(() =>
        // Restart RM
        createFreshContext('c7-3-restart', connectionString, dbName),
      )
      .then((restartContext) => {
        // replayInProgress still set → invalid
        expect(restartContext.lifecycleManager.getState('items')).toBe(
          'invalid',
        );

        // All replay data should be intact
        return cleanupClient
          .db(dbName)
          .collection('items_overview')
          .countDocuments();
      })
      .then((count) => {
        expect(count).toBe(3);
      });
  });

  // 7.1: CP dies during catch-up — RM is in catchup state, CP stops
  //      sending events. RM just stays in catchup. On restart → stopped
  //      (no replayInProgress for catch-up), data intact.
  test('7.1: CP dies during catch-up — RM in catchup, restart → stopped, data intact', () => {
    const dbName = 'c7-1-rm';
    return ensureStateDoc(dbName, 'items')
      .then(() => createFreshContext('c7-1-init', connectionString, dbName))
      .then((context) => {
        // Activate RM → enters catchup state
        return context.lifecycleManager
          .activate('items', 'corr-init')
          .then(() => {
            expect(context.lifecycleManager.getState('items')).toBe('catchup');

            // CP sends some catch-up events, then dies
            return cleanupClient
              .db(dbName)
              .collection('items_overview')
              .insertMany([
                { id: 'cu-1', name: 'CatchUp 1', ts: 500 },
                { id: 'cu-2', name: 'CatchUp 2', ts: 1000 },
              ]);
          })
          .then(() =>
            cleanupClient
              .db(dbName)
              .collection('readmodel.state')
              .updateOne(
                { name: 'items' },
                { $set: { lastProjectedEventTimestamp: 1000 } },
              ),
          )
          .then(() => {
            // CP dies — stops sending events, never sends catchupDone
            // RM stays in catchup with no replayInProgress flag
            // Verify: no replayInProgress set during catch-up
            return cleanupClient
              .db(dbName)
              .collection('readmodel.state')
              .findOne({ name: 'items' });
          })
          .then((doc) => {
            expect(doc.replayInProgress).toBeFalsy();
          });
      })
      .then(() =>
        // Restart RM
        createFreshContext('c7-1-restart', connectionString, dbName),
      )
      .then((restartContext) => {
        // No replayInProgress → stopped (not invalid)
        expect(restartContext.lifecycleManager.getState('items')).toBe(
          'stopped',
        );

        // Partial catch-up data preserved
        return cleanupClient
          .db(dbName)
          .collection('items_overview')
          .countDocuments();
      })
      .then((count) => {
        expect(count).toBe(2);

        // Timestamp preserved at the point reached
        return cleanupClient
          .db(dbName)
          .collection('readmodel.state')
          .findOne({ name: 'items' });
      })
      .then((doc) => {
        expect(doc.lastProjectedEventTimestamp).toBe(1000);
      });
  });

  // 7.4: CP dies during replay command processing — admin sends replay
  //      command, RM enters replay state (replayInProgress set). CP dies
  //      before processing any events. On RM restart → invalid.
  test('7.4: CP dies during replay processing — RM in replay, no events sent, restart → invalid', () => {
    const dbName = 'c7-4-rm';
    return ensureStateDoc(dbName, 'items')
      .then(() => createFreshContext('c7-4-init', connectionString, dbName))
      .then((context) => {
        // Activate, go live, stop, then start replay
        return context.lifecycleManager
          .activate('items', 'corr-init')
          .then(() =>
            context.lifecycleManager.catchupDone('items', 0, 'corr-init'),
          )
          .then(() => {
            context.lifecycleManager.stop('items', 'corr-stop');
            return context.lifecycleManager.startReplay('items', 'corr-replay');
          })
          .then(() => {
            expect(context.lifecycleManager.getState('items')).toBe('replay');

            // CP dies immediately — never processes any events
            // No events were projected at all
            return cleanupClient
              .db(dbName)
              .collection('items_overview')
              .countDocuments();
          })
          .then((count) => {
            expect(count).toBe(0);

            // Verify replayInProgress is set
            return cleanupClient
              .db(dbName)
              .collection('readmodel.state')
              .findOne({ name: 'items' });
          })
          .then((doc) => {
            expect(doc.replayInProgress).toBe(true);
          });
      })
      .then(() =>
        // Restart RM
        createFreshContext('c7-4-restart', connectionString, dbName),
      )
      .then((restartContext) => {
        // replayInProgress detected → invalid
        expect(restartContext.lifecycleManager.getState('items')).toBe(
          'invalid',
        );

        // No data was projected (CP never started)
        return cleanupClient
          .db(dbName)
          .collection('items_overview')
          .countDocuments();
      })
      .then((count) => {
        expect(count).toBe(0);
      });
  });
});
