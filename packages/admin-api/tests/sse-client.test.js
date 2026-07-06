import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { createStatusCache, parseSseChunk, createSseClient } =
  await import('../sse-client.js');

describe('parseSseChunk', () => {
  test('parses valid SSE chunk with event and data', () => {
    const chunk = 'event: status-change\ndata: {"state":"live"}';
    expect(parseSseChunk(chunk)).toEqual({
      type: 'status-change',
      data: { state: 'live' },
    });
  });

  test('returns null for chunk without event type', () => {
    const chunk = 'data: {"state":"live"}';
    expect(parseSseChunk(chunk)).toBeNull();
  });

  test('returns null for chunk without data', () => {
    const chunk = 'event: status-change';
    expect(parseSseChunk(chunk)).toBeNull();
  });

  test('returns null for invalid JSON data', () => {
    const chunk = 'event: status-change\ndata: not-json';
    expect(parseSseChunk(chunk)).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(parseSseChunk('')).toBeNull();
  });

  test('parses complex data payload', () => {
    const data = {
      endpointName: 'ep1',
      readModelName: 'customers',
      state: 'replay',
      lastProjectedEventTimestamp: 1710000000000,
    };
    const chunk = `event: status-change\ndata: ${JSON.stringify(data)}`;
    expect(parseSseChunk(chunk)).toEqual({
      type: 'status-change',
      data,
    });
  });
});

describe('createStatusCache', () => {
  let cache;

  beforeEach(() => {
    cache = createStatusCache();
  });

  test('starts with empty readModels and idle CP', () => {
    const state = cache.get();
    expect(state.readModels).toEqual({});
    expect(state.commandProcessor).toEqual({
      state: 'idle',
      activeReplays: [],
      activeCatchUps: [],
    });
  });

  test('updateReadModel stores RM status keyed by ep/rm', () => {
    cache.updateReadModel({
      endpointName: 'ep1',
      readModelName: 'customers',
      state: 'live',
      lastProjectedEventTimestamp: 100,
    });

    const rm = cache.getReadModel('ep1', 'customers');
    expect(rm).toEqual({
      endpointName: 'ep1',
      readModelName: 'customers',
      state: 'live',
      lastProjectedEventTimestamp: 100,
    });
  });

  test('getReadModel returns null for unknown RM', () => {
    expect(cache.getReadModel('ep1', 'unknown')).toBeNull();
  });

  test('getAllReadModels returns all cached RMs', () => {
    cache.updateReadModel({
      endpointName: 'ep1',
      readModelName: 'customers',
      state: 'live',
    });
    cache.updateReadModel({
      endpointName: 'ep1',
      readModelName: 'orders',
      state: 'idle',
    });

    const all = cache.getAllReadModels();
    expect(Object.keys(all)).toHaveLength(2);
    expect(all['ep1/customers'].state).toBe('live');
    expect(all['ep1/orders'].state).toBe('idle');
  });

  test('updateCommandProcessor replaces CP status', () => {
    cache.updateCommandProcessor({
      state: 'replaying',
      activeReplays: [{ readModel: 'customers' }],
      activeCatchUps: [],
    });

    const cp = cache.getCommandProcessor();
    expect(cp.state).toBe('replaying');
    expect(cp.activeReplays).toHaveLength(1);
  });

  test('get returns a snapshot of full cache state', () => {
    cache.updateReadModel({
      endpointName: 'ep1',
      readModelName: 'customers',
      state: 'live',
    });
    cache.updateCommandProcessor({ state: 'idle' });

    const snapshot = cache.get();
    expect(snapshot.readModels['ep1/customers'].state).toBe('live');
    expect(snapshot.commandProcessor.state).toBe('idle');
  });

  test('updateReadModel overwrites existing entry', () => {
    cache.updateReadModel({
      endpointName: 'ep1',
      readModelName: 'customers',
      state: 'idle',
    });
    cache.updateReadModel({
      endpointName: 'ep1',
      readModelName: 'customers',
      state: 'replay',
    });

    expect(cache.getReadModel('ep1', 'customers').state).toBe('replay');
  });

  test('updateReadModel rejects stale updates with lower stateVersion', () => {
    cache.updateReadModel({
      endpointName: 'ep1',
      readModelName: 'customers',
      state: 'live',
      stateVersion: 5,
    });
    // Stale HTTP response arrives with lower version
    cache.updateReadModel({
      endpointName: 'ep1',
      readModelName: 'customers',
      state: 'catchup',
      stateVersion: 3,
    });

    expect(cache.getReadModel('ep1', 'customers').state).toBe('live');
    expect(cache.getReadModel('ep1', 'customers').stateVersion).toBe(5);
  });

  test('updateReadModel accepts updates with equal stateVersion', () => {
    cache.updateReadModel({
      endpointName: 'ep1',
      readModelName: 'customers',
      state: 'catchup',
      stateVersion: 3,
    });
    cache.updateReadModel({
      endpointName: 'ep1',
      readModelName: 'customers',
      state: 'catchup',
      stateVersion: 3,
      lastProjectedEventTimestamp: 999,
    });

    expect(
      cache.getReadModel('ep1', 'customers').lastProjectedEventTimestamp,
    ).toBe(999);
  });

  test('updateReadModel accepts updates with higher stateVersion', () => {
    cache.updateReadModel({
      endpointName: 'ep1',
      readModelName: 'customers',
      state: 'catchup',
      stateVersion: 3,
    });
    cache.updateReadModel({
      endpointName: 'ep1',
      readModelName: 'customers',
      state: 'live',
      stateVersion: 4,
    });

    expect(cache.getReadModel('ep1', 'customers').state).toBe('live');
  });

  test('updateReadModel allows updates without stateVersion (backwards compat)', () => {
    cache.updateReadModel({
      endpointName: 'ep1',
      readModelName: 'customers',
      state: 'idle',
    });
    cache.updateReadModel({
      endpointName: 'ep1',
      readModelName: 'customers',
      state: 'live',
    });

    expect(cache.getReadModel('ep1', 'customers').state).toBe('live');
  });
});

describe('createSseClient', () => {
  let client;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network')));
    client = createSseClient({
      readModelServiceUrl: 'http://rm:3001',
      commandProcessorUrl: 'http://cp:3000',
      token: 'test-token',
    });
  });

  test('exposes cache, emitter, and lifecycle methods', () => {
    expect(client.cache).toBeDefined();
    expect(client.emitter).toBeDefined();
    expect(typeof client.addBrowserClient).toBe('function');
    expect(typeof client.removeBrowserClient).toBe('function');
    expect(typeof client.startOperation).toBe('function');
    expect(typeof client.endOperation).toBe('function');
    expect(typeof client.waitForStatus).toBe('function');
    expect(typeof client.fetchReplayRelevantEvents).toBe('function');
    expect(typeof client.fetchBackupList).toBe('function');
  });

  test('waitForStatus resolves immediately if predicate matches cache', () => {
    client.cache.updateReadModel({
      endpointName: 'ep1',
      readModelName: 'customers',
      state: 'live',
    });

    return client
      .waitForStatus((status) => {
        const rm = status.readModels['ep1/customers'];
        return rm && rm.state === 'live';
      })
      .then((status) => {
        expect(status.readModels['ep1/customers'].state).toBe('live');
      });
  });

  test('waitForStatus resolves when emitter fires matching event', () => {
    const promise = client.waitForStatus((status) => {
      const rm = status.readModels['ep1/customers'];
      return rm && rm.state === 'idle';
    });

    // Simulate SSE update
    client.cache.updateReadModel({
      endpointName: 'ep1',
      readModelName: 'customers',
      state: 'idle',
    });
    client.emitter.emit('status-change', client.cache.get());

    return promise.then((status) => {
      expect(status.readModels['ep1/customers'].state).toBe('idle');
    });
  });

  test('waitForStatus rejects on timeout', () => {
    const promise = client.waitForStatus(() => false, 50);

    return promise.catch((err) => {
      expect(err.message).toBe('Status wait timeout');
    });
  });

  test('getServiceUrls handles string URL', () => {
    const urls = client.getServiceUrls();
    expect(urls).toEqual(['http://rm:3001']);
  });

  test('getServiceUrls handles object URL mapping', () => {
    const c = createSseClient({
      readModelServiceUrl: {
        ep1: 'http://rm1:3001',
        ep2: 'http://rm2:3002',
      },
      commandProcessorUrl: 'http://cp:3000',
      token: 'test-token',
    });
    const urls = c.getServiceUrls();
    expect(urls).toContain('http://rm1:3001');
    expect(urls).toContain('http://rm2:3002');
  });

  test('getServiceUrls deduplicates URLs', () => {
    const c = createSseClient({
      readModelServiceUrl: {
        ep1: 'http://rm:3001',
        ep2: 'http://rm:3001',
      },
      commandProcessorUrl: 'http://cp:3000',
      token: 'test-token',
    });
    const urls = c.getServiceUrls();
    expect(urls).toEqual(['http://rm:3001']);
  });
});

describe('on-demand connection lifecycle', () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network')));
  });

  const createClient = (idleGraceMs = 50) =>
    createSseClient({
      readModelServiceUrl: { ep1: 'http://rm:3001' },
      commandProcessorUrl: 'http://cp:3000',
      token: 'test-token',
      idleGraceMs,
    });

  test('is not connected initially', () => {
    expect(createClient().isConnected()).toBe(false);
  });

  test('connects on first browser client', () => {
    const c = createClient();
    return c.addBrowserClient().then(() => {
      expect(c.isConnected()).toBe(true);
      c.disconnectAll();
    });
  });

  test('connects on first operation', () => {
    const c = createClient();
    return c.startOperation().then(() => {
      expect(c.isConnected()).toBe(true);
      c.disconnectAll();
    });
  });

  test('disconnects after grace period when last browser client leaves', () => {
    const c = createClient(50);
    return c
      .addBrowserClient()
      .then(() => {
        c.removeBrowserClient();
        // Teardown is not immediate — grace period applies
        expect(c.isConnected()).toBe(true);
        return wait(150);
      })
      .then(() => {
        expect(c.isConnected()).toBe(false);
      });
  });

  test('stays connected when a browser client returns within the grace period', () => {
    const c = createClient(50);
    return c
      .addBrowserClient()
      .then(() => {
        c.removeBrowserClient();
        return c.addBrowserClient();
      })
      .then(() => wait(150))
      .then(() => {
        expect(c.isConnected()).toBe(true);
        c.disconnectAll();
      });
  });

  test('stays connected while an operation is active even without browsers', () => {
    const c = createClient(50);
    return c
      .startOperation()
      .then(() => c.addBrowserClient())
      .then(() => {
        c.removeBrowserClient();
        return wait(150);
      })
      .then(() => {
        expect(c.isConnected()).toBe(true);
        c.endOperation();
        return wait(150);
      })
      .then(() => {
        expect(c.isConnected()).toBe(false);
      });
  });

  test('disconnects after grace period when last operation ends', () => {
    const c = createClient(50);
    return c
      .startOperation()
      .then(() => {
        c.endOperation();
        expect(c.isConnected()).toBe(true);
        return wait(150);
      })
      .then(() => {
        expect(c.isConnected()).toBe(false);
      });
  });

  test('stays connected while overlapping operations are active', () => {
    const c = createClient(50);
    return c
      .startOperation()
      .then(() => c.startOperation())
      .then(() => {
        c.endOperation();
        return wait(150);
      })
      .then(() => {
        expect(c.isConnected()).toBe(true);
        c.endOperation();
        return wait(150);
      })
      .then(() => {
        expect(c.isConnected()).toBe(false);
      });
  });

  test('reconnects on demand after an idle teardown', () => {
    const c = createClient(50);
    return c
      .startOperation()
      .then(() => {
        c.endOperation();
        return wait(150);
      })
      .then(() => {
        expect(c.isConnected()).toBe(false);
        return c.addBrowserClient();
      })
      .then(() => {
        expect(c.isConnected()).toBe(true);
        c.disconnectAll();
      });
  });

  test('disconnectAll takes effect immediately and cancels pending teardown', () => {
    const c = createClient(5000);
    return c
      .addBrowserClient()
      .then(() => {
        c.removeBrowserClient();
        c.disconnectAll();
        expect(c.isConnected()).toBe(false);
        return wait(100);
      })
      .then(() => {
        expect(c.isConnected()).toBe(false);
      });
  });
});
