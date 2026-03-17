import { describe, test, expect, vi, beforeAll, afterAll } from 'vitest';
import { MongoDBContainer } from '@testcontainers/mongodb';
import { MongoClient } from 'mongodb';
import { readFile, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';

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

const waitForCondition = async (fn, timeout = 10000, interval = 100) => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error('Timeout waiting for condition');
};

const jwtSecret = 'test-secret-for-integration-tests';

describe('command replay full-stack integration', { timeout: 120000 }, () => {
  let container;
  let connectionString;
  let cleanupClient;
  let commandServer;
  let commandPort;
  let commandRecordFile;
  let aggregateStore;

  beforeAll(async () => {
    container = await new MongoDBContainer('mongo:7').start();
    connectionString =
      container.getConnectionString() + '?directConnection=true';
    cleanupClient = await MongoClient.connect(connectionString);

    commandRecordFile = join(tmpdir(), `command-record-${randomUUID()}.jsonl`);

    // Register shared mqemitters
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

    commandServer = await startCommandProcessor(
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
    commandPort = commandServer.address().port;

    // Start read models
    await startReadModels(
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
  });

  afterAll(async () => {
    if (commandServer)
      await new Promise((resolve) => commandServer.close(resolve));
    if (cleanupClient) await cleanupClient.close();
    if (container) await container.stop();
    try {
      await unlink(commandRecordFile);
    } catch {
      // ignore if file doesn't exist
    }
  });

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

  const clearReadModel = async () => {
    const db = cleanupClient.db('readmodel-test');
    const collections = await db.listCollections().toArray();
    for (const col of collections) {
      await db.collection(col.name).deleteMany({});
    }
  };

  test('complete command replay cycle without auth', async () => {
    // Step 1: Send 3 commands
    const res1 = await sendCommand('item-1', 'Item One');
    expect(res1.status).toBe(200);

    const res2 = await sendCommand('item-2', 'Item Two');
    expect(res2.status).toBe(200);

    const res3 = await sendCommand('item-3', 'Item Three');
    expect(res3.status).toBe(200);

    // Step 2: Wait for projections to complete
    await waitForCondition(async () => {
      const items = await getReadModelItems();
      return items.length === 3;
    });

    // Step 3: Verify read model has 3 items
    const originalItems = await getReadModelItems();
    expect(originalItems).toHaveLength(3);
    expect(originalItems).toEqual(
      expect.arrayContaining([
        { id: 'item-1', name: 'Item One' },
        { id: 'item-2', name: 'Item Two' },
        { id: 'item-3', name: 'Item Three' },
      ]),
    );

    // Step 4: Read the recorded commands file
    const recordedContent = await readFile(commandRecordFile, 'utf8');
    const recordedLines = recordedContent
      .trim()
      .split('\n')
      .filter((l) => l.length > 0);
    expect(recordedLines).toHaveLength(3);

    const recordedCommands = recordedLines.map((line) => JSON.parse(line));
    recordedCommands.forEach((cmd) => {
      expect(cmd.command).toBe('CREATE_ITEM');
      expect(cmd.aggregateName).toBe('item');
      expect(cmd.payload).toHaveProperty('name');
    });

    // Step 5: Clear event store, read model, and aggregate store cache
    await clearEventStore();
    await clearReadModel();
    aggregateStore.clear();

    // Verify data is cleared
    const clearedItems = await getReadModelItems();
    expect(clearedItems).toHaveLength(0);

    // Step 6: Replay each recorded command
    for (const cmd of recordedCommands) {
      const res = await fetch(`http://127.0.0.1:${commandPort}/api/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: cmd.command,
          aggregateName: cmd.aggregateName,
          aggregateId: cmd.aggregateId,
          payload: cmd.payload,
        }),
      });
      expect(res.status).toBe(200);
    }

    // Step 7: Wait for projections
    await waitForCondition(async () => {
      const items = await getReadModelItems();
      return items.length === 3;
    });

    // Step 8: Verify read model matches original
    const replayedItems = await getReadModelItems();
    expect(replayedItems).toHaveLength(3);
    expect(replayedItems).toEqual(
      expect.arrayContaining([
        { id: 'item-1', name: 'Item One' },
        { id: 'item-2', name: 'Item Two' },
        { id: 'item-3', name: 'Item Three' },
      ]),
    );
  });

  test('command replay cycle with bearer token', async () => {
    // Clear data from previous test
    await clearEventStore();
    await clearReadModel();
    aggregateStore.clear();

    // Step 1: Create a JWT
    const token = jwt.sign({ user: 'testuser', roles: ['admin'] }, jwtSecret, {
      expiresIn: '1h',
    });
    const authHeaders = { Authorization: `Bearer ${token}` };

    // Step 2: Send commands with auth
    const res1 = await sendCommand('auth-item-1', 'Auth Item One', authHeaders);
    expect(res1.status).toBe(200);

    const res2 = await sendCommand('auth-item-2', 'Auth Item Two', authHeaders);
    expect(res2.status).toBe(200);

    // Step 3: Wait for projections
    await waitForCondition(async () => {
      const items = await getReadModelItems();
      return items.length === 2;
    });

    // Verify original data
    const originalItems = await getReadModelItems();
    expect(originalItems).toHaveLength(2);
    expect(originalItems).toEqual(
      expect.arrayContaining([
        { id: 'auth-item-1', name: 'Auth Item One' },
        { id: 'auth-item-2', name: 'Auth Item Two' },
      ]),
    );

    // Step 4: Read recorded commands and verify auth info is captured
    const recordedContent = await readFile(commandRecordFile, 'utf8');
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
    await clearEventStore();
    await clearReadModel();
    aggregateStore.clear();

    const clearedItems = await getReadModelItems();
    expect(clearedItems).toHaveLength(0);

    // Record file line count before replay, so we can check new lines after
    const preReplayContent = await readFile(commandRecordFile, 'utf8');
    const preReplayLineCount = preReplayContent
      .trim()
      .split('\n')
      .filter((l) => l.length > 0).length;

    // Step 6: Replay commands with Bearer token
    for (const cmd of authCommands) {
      const res = await fetch(`http://127.0.0.1:${commandPort}/api/command`, {
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
      });
      expect(res.status).toBe(200);
    }

    // Step 7: Wait for projections
    await waitForCondition(async () => {
      const items = await getReadModelItems();
      return items.length === 2;
    });

    // Step 8: Verify read model matches original
    const replayedItems = await getReadModelItems();
    expect(replayedItems).toHaveLength(2);
    expect(replayedItems).toEqual(
      expect.arrayContaining([
        { id: 'auth-item-1', name: 'Auth Item One' },
        { id: 'auth-item-2', name: 'Auth Item Two' },
      ]),
    );

    // Step 9: Verify replayed commands also recorded auth info
    // The command recorder is still active during replay, so the
    // replay commands should appear as new lines in the recording file
    // with the auth info from the bearer token.
    const postReplayContent = await readFile(commandRecordFile, 'utf8');
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
  });
});
