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

const { mongoKeyStore } = await import('../keystores/mongo.js');

describe('mongoKeyStore integration', { timeout: 60000 }, () => {
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

  test('stores DEK, retrieves it, verifies round-trip', async () => {
    const rootSecret = randomBytes(32);
    const ks = await mongoKeyStore({
      url: connectionString,
      rootSecret,
      database: 'test-integration-roundtrip',
      dekCollection: 'deks',
    }).initialize();

    const dek = randomBytes(32);
    const wrapped = await ks.wrapDEK('personal', dek);

    await ks.storeDEK('sub-1', 'personal', {
      wrappedKey: wrapped,
      version: 1,
    });

    const retrieved = await ks.getDEK('sub-1', 'personal');
    expect(retrieved).not.toBeNull();
    expect(retrieved.version).toBe(1);

    const unwrapped = await ks.unwrapDEK('personal', retrieved.wrappedKey);
    expect(Buffer.compare(unwrapped, dek)).toBe(0);

    await ks.close();
  });

  test('deletes keys for subject and verifies they are gone', async () => {
    const rootSecret = randomBytes(32);
    const ks = await mongoKeyStore({
      url: connectionString,
      rootSecret,
      database: 'test-integration-delete',
      dekCollection: 'deks',
    }).initialize();

    const dek = randomBytes(32);
    const wrapped = await ks.wrapDEK('personal', dek);

    await ks.storeDEK('sub-del', 'personal', {
      wrappedKey: wrapped,
      version: 1,
    });
    await ks.storeDEK('sub-del', 'financial', {
      wrappedKey: wrapped,
      version: 1,
    });

    // Verify they exist
    const before1 = await ks.getDEK('sub-del', 'personal');
    const before2 = await ks.getDEK('sub-del', 'financial');
    expect(before1).not.toBeNull();
    expect(before2).not.toBeNull();

    // Delete
    await ks.deleteKeysForSubject('sub-del');

    // Verify gone
    const after1 = await ks.getDEK('sub-del', 'personal');
    const after2 = await ks.getDEK('sub-del', 'financial');
    expect(after1).toEqual({ forgotten: true });
    expect(after2).toEqual({ forgotten: true });

    await ks.close();
  });

  test('gets all DEKs for context and verifies completeness', async () => {
    const rootSecret = randomBytes(32);
    const ks = await mongoKeyStore({
      url: connectionString,
      rootSecret,
      database: 'test-integration-getall',
      dekCollection: 'deks',
    }).initialize();

    const dek = randomBytes(32);
    const wrapped = await ks.wrapDEK('personal', dek);

    await ks.storeDEK('sub-a', 'personal', {
      wrappedKey: wrapped,
      version: 1,
    });
    await ks.storeDEK('sub-b', 'personal', {
      wrappedKey: wrapped,
      version: 1,
    });
    await ks.storeDEK('sub-c', 'financial', {
      wrappedKey: wrapped,
      version: 1,
    });

    const personalDeks = await ks.getAllDEKsForContext('personal');
    expect(personalDeks).toHaveLength(2);
    const subjects = personalDeks.map((d) => d.subjectId).sort();
    expect(subjects).toEqual(['sub-a', 'sub-b']);

    const financialDeks = await ks.getAllDEKsForContext('financial');
    expect(financialDeks).toHaveLength(1);
    expect(financialDeks[0].subjectId).toBe('sub-c');

    await ks.close();
  });

  test('stores DEK with version and verifies retrieval', async () => {
    const rootSecret = randomBytes(32);
    const ks = await mongoKeyStore({
      url: connectionString,
      rootSecret,
      database: 'test-integration-version',
      dekCollection: 'deks',
    }).initialize();

    const dek = randomBytes(32);
    const wrapped = await ks.wrapDEK('personal', dek);

    await ks.storeDEK('sub-v', 'personal', {
      wrappedKey: wrapped,
      version: 1,
    });
    await ks.storeDEK('sub-v', 'personal', {
      wrappedKey: wrapped,
      version: 2,
    });

    // Without version, should get latest (version 2)
    const latest = await ks.getDEK('sub-v', 'personal');
    expect(latest.version).toBe(2);

    // With specific version
    const v1 = await ks.getDEK('sub-v', 'personal', 1);
    expect(v1.version).toBe(1);

    await ks.close();
  });
});
