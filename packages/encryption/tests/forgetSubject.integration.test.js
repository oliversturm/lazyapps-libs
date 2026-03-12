import { describe, test, expect, vi, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { MongoDBContainer } from '@testcontainers/mongodb';
import { MongoClient } from 'mongodb';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

const { createEncryption } = await import('../encryption.js');
const { defineEncryptionSchema } = await import('../schema.js');
const { inMemoryKeyStore } = await import('../keystores/inmemory.js');
const { mongoKeyStore } = await import('../keystores/mongo.js');

const personalKEK = randomBytes(32);

const schema = defineEncryptionSchema({
  events: {
    CUSTOMER_CREATED: {
      'payload.name': {
        context: 'personal',
        subjectField: 'aggregateId',
      },
      'payload.email': {
        context: 'personal',
        subjectField: 'aggregateId',
      },
    },
  },
});

const contexts = {
  personal: { roles: ['admin', 'support'], autoForget: true },
};

describe('forget-subject integration', { timeout: 60000 }, () => {
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

  describe('crypto-shredding lifecycle with inMemoryKeyStore', () => {
    test('encrypts, forgets, and returns fallback values', async () => {
      const enc = await createEncryption({
        schema,
        keyStore: inMemoryKeyStore({ personal: personalKEK }),
        contexts,
        cache: { maxSize: 100, ttlMs: 60000 },
      });

      const storedEvents = [];
      const mockStore = {
        addEvent: () => (event) => {
          storedEvents.push(event);
          return Promise.resolve(event);
        },
        replay: vi.fn(),
        close: vi.fn(),
      };
      const wrappedFactory = enc.wrapEventStore(() =>
        Promise.resolve(mockStore),
      );
      const wrapped = await wrappedFactory();

      // Store an event with PII
      const returned = await wrapped.addEvent('corr-1')({
        type: 'CUSTOMER_CREATED',
        aggregateName: 'customer',
        aggregateId: 'cust-100',
        payload: { name: 'Alice Smith', email: 'alice@example.com' },
        timestamp: Date.now(),
      });

      // Returned event should be plaintext
      expect(returned.payload.name).toBe('Alice Smith');
      expect(returned.payload.email).toBe('alice@example.com');

      // Stored event should be encrypted
      expect(storedEvents[0].payload.name.__encrypted).toBe(true);
      expect(storedEvents[0].payload.email.__encrypted).toBe(true);

      // Decrypt works before forget
      const decryptor = enc.createProjectionDecryptor('admin');
      const beforeForget = await decryptor(storedEvents[0]);
      expect(beforeForget.payload.name).toBe('Alice Smith');

      // Forget the subject
      await enc.forgetSubject('cust-100');

      // After forget, decryption returns fallback
      const afterForget = await decryptor(storedEvents[0]);
      expect(afterForget.payload.name).toEqual({
        forgotten: true,
        text: '[deleted]',
      });
      expect(afterForget.payload.email).toEqual({
        forgotten: true,
        text: '[deleted]',
      });
    });
  });

  describe('selective forgetting', () => {
    test('forgetting one subject leaves another decryptable', async () => {
      const enc = await createEncryption({
        schema,
        keyStore: inMemoryKeyStore({ personal: personalKEK }),
        contexts,
        cache: { maxSize: 100, ttlMs: 60000 },
      });

      const published = [];
      const mockBus = {
        publishEvent: () => (event) => {
          published.push(event);
          return event;
        },
        publishReplayState: vi.fn(),
      };
      const wrappedBusFactory = enc.wrapEventBus(() =>
        Promise.resolve(mockBus),
      );
      const wrappedBus = await wrappedBusFactory();

      // Encrypt events for two subjects
      await wrappedBus.publishEvent('corr-1')({
        type: 'CUSTOMER_CREATED',
        aggregateName: 'customer',
        aggregateId: 'cust-A',
        payload: { name: 'Alice', email: 'alice@test.com' },
        timestamp: 1,
      });

      await wrappedBus.publishEvent('corr-2')({
        type: 'CUSTOMER_CREATED',
        aggregateName: 'customer',
        aggregateId: 'cust-B',
        payload: { name: 'Bob', email: 'bob@test.com' },
        timestamp: 2,
      });

      // Forget only cust-A
      await enc.forgetSubject('cust-A');

      const decryptor = enc.createProjectionDecryptor('admin');

      // cust-A should be deleted
      const resultA = await decryptor(published[0]);
      expect(resultA.payload.name).toEqual({
        forgotten: true,
        text: '[deleted]',
      });
      expect(resultA.payload.email).toEqual({
        forgotten: true,
        text: '[deleted]',
      });

      // cust-B should still decrypt
      const resultB = await decryptor(published[1]);
      expect(resultB.payload.name).toBe('Bob');
      expect(resultB.payload.email).toBe('bob@test.com');
    });
  });

  describe('mongoKeyStore with real MongoDB', () => {
    test('stores and deletes DEK documents in MongoDB', async () => {
      const rootSecret = randomBytes(32);
      const enc = await createEncryption({
        schema,
        keyStore: mongoKeyStore({
          url: connectionString,
          rootSecret,
          database: 'test-forget-keys',
          dekCollection: 'test-deks',
        }),
        contexts,
        cache: { maxSize: 100, ttlMs: 60000 },
      });

      const storedEvents = [];
      const mockStore = {
        addEvent: () => (event) => {
          storedEvents.push(event);
          return Promise.resolve(event);
        },
        replay: vi.fn(),
        close: vi.fn(),
      };
      const wrappedFactory = enc.wrapEventStore(() =>
        Promise.resolve(mockStore),
      );
      const wrapped = await wrappedFactory();

      // Store encrypted event
      await wrapped.addEvent('corr-1')({
        type: 'CUSTOMER_CREATED',
        aggregateName: 'customer',
        aggregateId: 'cust-mongo-1',
        payload: { name: 'Charlie', email: 'charlie@test.com' },
        timestamp: Date.now(),
      });

      // Verify DEK documents exist in MongoDB
      const client = await MongoClient.connect(connectionString);
      const db = client.db('test-forget-keys');
      const deksBefore = await db
        .collection('test-deks')
        .find({ subjectId: 'cust-mongo-1' })
        .toArray();
      expect(deksBefore.length).toBeGreaterThan(0);

      // Forget the subject
      await enc.forgetSubject('cust-mongo-1');

      // Verify DEK documents are deleted from MongoDB
      const deksAfter = await db
        .collection('test-deks')
        .find({ subjectId: 'cust-mongo-1' })
        .toArray();
      expect(deksAfter).toHaveLength(0);

      // Verify decryption returns fallback
      const decryptor = enc.createProjectionDecryptor('admin');
      const result = await decryptor(storedEvents[0]);
      expect(result.payload.name).toEqual({
        forgotten: true,
        text: '[deleted]',
      });
      expect(result.payload.email).toEqual({
        forgotten: true,
        text: '[deleted]',
      });

      await client.close();
    });

    test('does not delete DEKs for other subjects', async () => {
      const rootSecret = randomBytes(32);
      const enc = await createEncryption({
        schema,
        keyStore: mongoKeyStore({
          url: connectionString,
          rootSecret,
          database: 'test-forget-selective',
          dekCollection: 'test-deks',
        }),
        contexts,
        cache: { maxSize: 100, ttlMs: 60000 },
      });

      const mockStore = {
        addEvent: () => (event) => Promise.resolve(event),
        replay: vi.fn(),
        close: vi.fn(),
      };
      const wrappedFactory = enc.wrapEventStore(() =>
        Promise.resolve(mockStore),
      );
      const wrapped = await wrappedFactory();

      // Store events for two subjects
      await wrapped.addEvent('corr-1')({
        type: 'CUSTOMER_CREATED',
        aggregateName: 'customer',
        aggregateId: 'cust-keep',
        payload: { name: 'Keep Me', email: 'keep@test.com' },
        timestamp: 1,
      });

      await wrapped.addEvent('corr-2')({
        type: 'CUSTOMER_CREATED',
        aggregateName: 'customer',
        aggregateId: 'cust-forget',
        payload: { name: 'Forget Me', email: 'forget@test.com' },
        timestamp: 2,
      });

      // Forget only one subject
      await enc.forgetSubject('cust-forget');

      // Verify the other subject's DEKs still exist
      const client = await MongoClient.connect(connectionString);
      const db = client.db('test-forget-selective');
      const remainingDeks = await db
        .collection('test-deks')
        .find({ subjectId: 'cust-keep' })
        .toArray();
      expect(remainingDeks.length).toBeGreaterThan(0);

      const deletedDeks = await db
        .collection('test-deks')
        .find({ subjectId: 'cust-forget' })
        .toArray();
      expect(deletedDeks).toHaveLength(0);

      await client.close();
    });
  });

  describe('key rotation', () => {
    test('rejects rotation for key stores that do not support it', async () => {
      const enc = await createEncryption({
        schema,
        keyStore: inMemoryKeyStore({ personal: personalKEK }),
        contexts,
        cache: { maxSize: 100, ttlMs: 60000 },
      });

      await expect(enc.rotateContextKey('personal')).rejects.toThrow(
        'KEK rotation not supported',
      );
    });

    test('rejects rotation for mongoKeyStore (no rotateKEK method)', async () => {
      const rootSecret = randomBytes(32);
      const enc = await createEncryption({
        schema,
        keyStore: mongoKeyStore({
          url: connectionString,
          rootSecret,
          database: 'test-rotation',
          dekCollection: 'test-deks',
        }),
        contexts,
        cache: { maxSize: 100, ttlMs: 60000 },
      });

      await expect(enc.rotateContextKey('personal')).rejects.toThrow(
        'KEK rotation not supported',
      );
    });
  });

  describe('SUBJECT_FORGOTTEN event via wrapped event store', () => {
    test('triggers crypto-shredding when SUBJECT_FORGOTTEN is stored', async () => {
      const enc = await createEncryption({
        schema,
        keyStore: inMemoryKeyStore({ personal: personalKEK }),
        contexts,
        cache: { maxSize: 100, ttlMs: 60000 },
      });

      const storedEvents = [];
      const mockStore = {
        addEvent: () => (event) => {
          storedEvents.push(event);
          return Promise.resolve(event);
        },
        replay: vi.fn(),
        close: vi.fn(),
      };
      const wrappedFactory = enc.wrapEventStore(() =>
        Promise.resolve(mockStore),
      );
      const wrapped = await wrappedFactory();

      // Encrypt an event
      await wrapped.addEvent('corr-1')({
        type: 'CUSTOMER_CREATED',
        aggregateName: 'customer',
        aggregateId: 'cust-shred',
        payload: { name: 'To Be Shredded', email: 'shred@test.com' },
        timestamp: 1,
      });

      // Process SUBJECT_FORGOTTEN through the wrapped event store
      await wrapped.addEvent('corr-2')({
        type: 'SUBJECT_FORGOTTEN',
        aggregateName: 'customer',
        aggregateId: 'cust-shred',
        payload: { subjectId: 'cust-shred', contexts: ['personal'] },
        timestamp: 2,
      });

      // Verify DEKs are deleted — decryption should return fallback
      const decryptor = enc.createProjectionDecryptor('admin');
      const result = await decryptor(storedEvents[0]);
      expect(result.payload.name).toEqual({
        forgotten: true,
        text: '[deleted]',
      });
      expect(result.payload.email).toEqual({
        forgotten: true,
        text: '[deleted]',
      });
    });
  });
});
