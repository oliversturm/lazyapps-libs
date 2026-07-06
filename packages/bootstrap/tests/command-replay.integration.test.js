import { describe, test, expect, vi, beforeAll, afterAll } from 'vitest';
import { MongoDBContainer } from '@testcontainers/mongodb';
import { MongoClient } from 'mongodb';
import { readFile, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import { waitForCondition } from './helpers/waitForCondition.js';

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
const { registerSharedMqEmitter } = await import('@lazyapps/mqemitter');
const { inmemory: aggregateStoreInmemory } =
  await import('@lazyapps/aggregatestore-inmemory');
const { mongodb: eventStoreMongo } =
  await import('@lazyapps/eventstore-mongodb');
const { mongodb: readModelStorageMongo } =
  await import('@lazyapps/readmodelstorage-mongodb');
const { startCommandProcessor } = await import('@lazyapps/command-processor');
const { startReadModels } = await import('@lazyapps/readmodels');
const {
  commandProcessorEventBusMqEmitter,
  readModelEventBusMqEmitter,
  readModelListenerMqEmitter,
  commandSenderMqEmitter,
} = await import('@lazyapps/mqemitter');
const { express: expressReceiver } =
  await import('@lazyapps/express/command-receiver/index.js');

const testAggregates = {
  item: {
    initial: () => ({}),
    commands: {
      CREATE_ITEM: (aggregate, payload) => {
        if (aggregate.created)
          throw Object.assign(new Error('Already exists'), {
            name: 'ValidationError',
          });
        return { type: 'ITEM_CREATED', payload };
      },
    },
    projections: {
      ITEM_CREATED: (aggregate, event) => ({
        ...aggregate,
        created: true,
        ...event.payload,
      }),
    },
  },
};

const testReadModels = {
  items: {
    projections: {
      ITEM_CREATED: ({ storage, changeNotification }, event) =>
        storage
          .insertOne('items', {
            id: event.aggregateId,
            name: event.payload.name,
          })
          .then(() => changeNotification.sendChangeNotification('items')),
    },
    resolvers: {
      all: (storage) => storage.find('items', {}).project({ _id: 0 }).toArray(),
    },
  },
};

const jwtSecret = 'test-secret-for-integration-tests';

describe(
  'command replay full-stack integration',
  { timeout: 30000, sequential: true, shuffle: false },
  () => {
    let container;
    let connectionString;
    let cleanupClient;
    let commandServer;
    let commandPort;
    let commandRecordFile;
    let aggregateStore;

    beforeAll(() => {
      console.log('[SETUP] Starting MongoDB container');
      return new MongoDBContainer('mongo:7')
        .start()
        .then((c) => {
          container = c;
          connectionString = c.getConnectionString() + '?directConnection=true';
          console.log('[SETUP] MongoDB container started');
          console.log(`[SETUP] Connection string: ${connectionString}`);
          return MongoClient.connect(connectionString);
        })
        .then((client) => {
          cleanupClient = client;
          commandRecordFile = join(
            tmpdir(),
            `command-record-${randomUUID()}.jsonl`,
          );

          // Register shared mqemitters
          console.log('[SETUP] Registering mqemitters');
          registerSharedMqEmitter('commands', mqemitter());
          registerSharedMqEmitter('events', mqemitter());
          registerSharedMqEmitter('queries', mqemitter());

          // Start command processor
          // Wrap the aggregate store factory to capture the instance for
          // clearing between original run and replay in tests.
          const innerFactory = aggregateStoreInmemory();
          const capturingFactory = (aggregates) => {
            aggregateStore = innerFactory(aggregates);
            return aggregateStore;
          };

          console.log('[SETUP] Starting command processor');
          return startCommandProcessor(
            { serviceId: 'REPLAY-TEST' },
            {
              receiver: expressReceiver({
                port: 0,
                jwtSecret,
                credentialsRequired: false,
              }),
              aggregateStore: capturingFactory,
              eventStore: eventStoreMongo({
                url: connectionString,
                database: 'events',
              }),
              eventBus: commandProcessorEventBusMqEmitter({
                mqName: 'events',
              }),
              aggregates: testAggregates,
              commandRecording: {
                enabled: true,
                filePath: commandRecordFile,
              },
            },
          );
        })
        .then((server) => {
          commandServer = server;
          commandPort = server.address().port;
          console.log(
            `[SETUP] Command processor started on port ${commandPort}`,
          );

          // Start read models
          console.log('[SETUP] Starting read models');
          return startReadModels(
            { serviceId: 'REPLAY-TEST' },
            {
              readModels: testReadModels,
              storage: readModelStorageMongo({
                url: connectionString,
                database: 'readmodel-test',
              }),
              eventBus: readModelEventBusMqEmitter({ mqName: 'events' }),
              listener: readModelListenerMqEmitter({ mqName: 'queries' }),
              changeNotificationSender: {
                sendChangeNotification: () => () => Promise.resolve(),
              },
              commandSender: commandSenderMqEmitter({ mqName: 'commands' }),
            },
          );
        })
        .then(() => {
          console.log('[SETUP] Read models started, setup complete');
        });
    });

    afterAll(() =>
      Promise.resolve()
        .then(() =>
          commandServer
            ? new Promise((resolve) => commandServer.close(resolve))
            : undefined,
        )
        .then(() => (cleanupClient ? cleanupClient.close() : undefined))
        .then(() => (container ? container.stop() : undefined))
        .then(() => unlink(commandRecordFile).catch(() => {})),
    );

    const sendCommand = (aggregateId, name, headers = {}) =>
      fetch(`http://127.0.0.1:${commandPort}/api/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({
          command: 'CREATE_ITEM',
          aggregateName: 'item',
          aggregateId,
          payload: { name },
        }),
      });

    const getReadModelItems = () =>
      cleanupClient
        .db('readmodel-test')
        .collection('items')
        .find({}, { projection: { _id: 0 } })
        .sort({ id: 1 })
        .toArray();

    const clearEventStore = () =>
      cleanupClient.db('events').collection('events').deleteMany({});

    const clearReadModel = () =>
      cleanupClient
        .db('readmodel-test')
        .listCollections()
        .toArray()
        .then((collections) =>
          collections.reduce(
            (chain, col) =>
              chain.then(() =>
                cleanupClient
                  .db('readmodel-test')
                  .collection(col.name)
                  .deleteMany({}),
              ),
            Promise.resolve(),
          ),
        );

    test('complete command replay cycle without auth', () => {
      console.log('[TEST no-auth] Sending 3 commands');
      // Step 1: Send 3 commands
      return sendCommand('item-1', 'Item One')
        .then((res1) => {
          expect(res1.status).toBe(200);
          return sendCommand('item-2', 'Item Two');
        })
        .then((res2) => {
          expect(res2.status).toBe(200);
          return sendCommand('item-3', 'Item Three');
        })
        .then((res3) => {
          expect(res3.status).toBe(200);
          console.log(
            '[TEST no-auth] All 3 commands sent, waiting for projections',
          );

          // Step 2: Wait for projections to complete
          return waitForCondition(
            () =>
              getReadModelItems().then((items) =>
                items.length === 3 ? true : `items.length=${items.length}`,
              ),
            10000,
            100,
            'projections complete (3 items)',
          );
        })
        .then(() => {
          // Step 3: Verify read model has 3 items
          console.log('[TEST no-auth] Verifying read model');
          return getReadModelItems();
        })
        .then((originalItems) => {
          expect(originalItems).toHaveLength(3);
          expect(originalItems).toEqual(
            expect.arrayContaining([
              { id: 'item-1', name: 'Item One' },
              { id: 'item-2', name: 'Item Two' },
              { id: 'item-3', name: 'Item Three' },
            ]),
          );

          // Step 4: Read the recorded commands file
          console.log('[TEST no-auth] Reading recorded commands');
          return readFile(commandRecordFile, 'utf8');
        })
        .then((recordedContent) => {
          const recordedLines = recordedContent
            .trim()
            .split('\n')
            .filter((l) => l.length > 0);
          expect(recordedLines).toHaveLength(3);

          const recordedCommands = recordedLines.map((line) =>
            JSON.parse(line),
          );
          recordedCommands.forEach((cmd) => {
            expect(cmd.command).toBe('CREATE_ITEM');
            expect(cmd.aggregateName).toBe('item');
            expect(cmd.payload).toHaveProperty('name');
          });

          // Step 5: Clear event store, read model, and aggregate store cache
          console.log(
            '[TEST no-auth] Clearing event store, read model, aggregate store',
          );
          return clearEventStore()
            .then(() => clearReadModel())
            .then(() => {
              aggregateStore.clear();
              return getReadModelItems();
            })
            .then((clearedItems) => {
              expect(clearedItems).toHaveLength(0);
              return recordedCommands;
            });
        })
        .then((recordedCommands) => {
          // Step 6: Replay each recorded command
          console.log('[TEST no-auth] Replaying recorded commands');
          return recordedCommands.reduce(
            (chain, cmd) =>
              chain.then(() =>
                fetch(`http://127.0.0.1:${commandPort}/api/command`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    command: cmd.command,
                    aggregateName: cmd.aggregateName,
                    aggregateId: cmd.aggregateId,
                    payload: cmd.payload,
                  }),
                }).then((res) => {
                  expect(res.status).toBe(200);
                }),
              ),
            Promise.resolve(),
          );
        })
        .then(() => {
          // Step 7: Wait for projections
          console.log('[TEST no-auth] Waiting for replay projections');
          return waitForCondition(
            () =>
              getReadModelItems().then((items) =>
                items.length === 3 ? true : `items.length=${items.length}`,
              ),
            10000,
            100,
            'replay projections complete (3 items)',
          );
        })
        .then(() => {
          // Step 8: Verify read model matches original
          console.log('[TEST no-auth] Verifying replayed read model');
          return getReadModelItems();
        })
        .then((replayedItems) => {
          expect(replayedItems).toHaveLength(3);
          expect(replayedItems).toEqual(
            expect.arrayContaining([
              { id: 'item-1', name: 'Item One' },
              { id: 'item-2', name: 'Item Two' },
              { id: 'item-3', name: 'Item Three' },
            ]),
          );
        });
    });

    test('command replay cycle with bearer token', () => {
      // Clear data from previous test
      console.log('[TEST auth] Clearing data from previous test');
      return clearEventStore()
        .then(() => clearReadModel())
        .then(() => {
          aggregateStore.clear();

          // Step 1: Create a JWT
          const token = jwt.sign(
            { user: 'testuser', roles: ['admin'] },
            jwtSecret,
            {
              expiresIn: '1h',
            },
          );
          const authHeaders = { Authorization: `Bearer ${token}` };

          // Step 2: Send commands with auth
          console.log('[TEST auth] Sending 2 commands with bearer token');
          return sendCommand('auth-item-1', 'Auth Item One', authHeaders)
            .then((res1) => {
              expect(res1.status).toBe(200);
              return sendCommand('auth-item-2', 'Auth Item Two', authHeaders);
            })
            .then((res2) => {
              expect(res2.status).toBe(200);

              // Step 3: Wait for projections
              console.log('[TEST auth] Waiting for projections');
              return waitForCondition(
                () =>
                  getReadModelItems().then((items) =>
                    items.length === 2 ? true : `items.length=${items.length}`,
                  ),
                10000,
                100,
                'auth projections complete (2 items)',
              );
            })
            .then(() => getReadModelItems())
            .then((originalItems) => {
              expect(originalItems).toHaveLength(2);
              expect(originalItems).toEqual(
                expect.arrayContaining([
                  { id: 'auth-item-1', name: 'Auth Item One' },
                  { id: 'auth-item-2', name: 'Auth Item Two' },
                ]),
              );

              // Step 4: Read recorded commands and verify auth info is captured
              console.log('[TEST auth] Reading recorded commands');
              return readFile(commandRecordFile, 'utf8');
            })
            .then((recordedContent) => {
              const recordedLines = recordedContent
                .trim()
                .split('\n')
                .filter((l) => l.length > 0);

              // Find the auth commands (last 2 lines, since the file also has commands from test 1)
              const authCommands = recordedLines
                .map((line) => JSON.parse(line))
                .filter((cmd) => cmd.aggregateId.startsWith('auth-item-'));

              expect(authCommands).toHaveLength(2);
              authCommands.forEach((cmd) => {
                expect(cmd.auth).toBeDefined();
                expect(cmd.auth.user).toBe('testuser');
                expect(cmd.auth.roles).toEqual(['admin']);
              });

              // Step 5: Clear event store, read model, and aggregate store cache
              console.log('[TEST auth] Clearing stores for replay');
              return clearEventStore()
                .then(() => clearReadModel())
                .then(() => {
                  aggregateStore.clear();
                  return getReadModelItems();
                })
                .then((clearedItems) => {
                  expect(clearedItems).toHaveLength(0);

                  // Record file line count before replay
                  return readFile(commandRecordFile, 'utf8').then(
                    (preReplayContent) => {
                      const preReplayLineCount = preReplayContent
                        .trim()
                        .split('\n')
                        .filter((l) => l.length > 0).length;
                      return { authCommands, authHeaders, preReplayLineCount };
                    },
                  );
                });
            })
            .then(({ authCommands, authHeaders, preReplayLineCount }) => {
              // Step 6: Replay commands with Bearer token
              console.log('[TEST auth] Replaying commands with bearer token');
              return authCommands
                .reduce(
                  (chain, cmd) =>
                    chain.then(() =>
                      fetch(`http://127.0.0.1:${commandPort}/api/command`, {
                        method: 'POST',
                        headers: {
                          'Content-Type': 'application/json',
                          ...authHeaders,
                        },
                        body: JSON.stringify({
                          command: cmd.command,
                          aggregateName: cmd.aggregateName,
                          aggregateId: cmd.aggregateId,
                          payload: cmd.payload,
                        }),
                      }).then((res) => {
                        expect(res.status).toBe(200);
                      }),
                    ),
                  Promise.resolve(),
                )
                .then(() => preReplayLineCount);
            })
            .then((preReplayLineCount) => {
              // Step 7: Wait for projections
              console.log('[TEST auth] Waiting for replay projections');
              return waitForCondition(
                () =>
                  getReadModelItems().then((items) =>
                    items.length === 2 ? true : `items.length=${items.length}`,
                  ),
                10000,
                100,
                'auth replay projections complete (2 items)',
              ).then(() => preReplayLineCount);
            })
            .then((preReplayLineCount) => {
              // Step 8: Verify read model matches original
              console.log('[TEST auth] Verifying replayed read model');
              return getReadModelItems().then((replayedItems) => {
                expect(replayedItems).toHaveLength(2);
                expect(replayedItems).toEqual(
                  expect.arrayContaining([
                    { id: 'auth-item-1', name: 'Auth Item One' },
                    { id: 'auth-item-2', name: 'Auth Item Two' },
                  ]),
                );
                return preReplayLineCount;
              });
            })
            .then((preReplayLineCount) => {
              // Step 9: Verify replayed commands also recorded auth info
              console.log(
                '[TEST auth] Verifying replayed commands recorded auth info',
              );
              return readFile(commandRecordFile, 'utf8').then(
                (postReplayContent) => {
                  const postReplayLines = postReplayContent
                    .trim()
                    .split('\n')
                    .filter((l) => l.length > 0);
                  const newLines = postReplayLines.slice(preReplayLineCount);
                  expect(newLines.length).toBeGreaterThanOrEqual(2);

                  const replayedAuthCommands = newLines
                    .map((line) => JSON.parse(line))
                    .filter((cmd) => cmd.aggregateId.startsWith('auth-item-'));
                  expect(replayedAuthCommands).toHaveLength(2);
                  replayedAuthCommands.forEach((cmd) => {
                    expect(cmd.auth).toBeDefined();
                    expect(cmd.auth.user).toBe('testuser');
                    expect(cmd.auth.roles).toEqual(['admin']);
                  });
                },
              );
            });
        });
    });
  },
);
