import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockReplayHandler = {
  startReplay: vi.fn(),
  cancelReplay: vi.fn(),
  getReplayStatus: vi.fn(),
};

vi.mock('@lazyapps/command-processor/replayHandler.js', () => ({
  createReplayHandler: vi.fn().mockReturnValue(mockReplayHandler),
}));

const mockInstallReplayAdminApi = vi.fn().mockReturnValue(vi.fn());
const mockInstallReadModelAdminApi = vi.fn().mockReturnValue(vi.fn());

vi.mock('@lazyapps/admin-api', () => ({
  installReplayAdminApi: mockInstallReplayAdminApi,
  installReadModelAdminApi: mockInstallReadModelAdminApi,
}));

const mockListen = vi.fn();
const mockUse = vi.fn();
const mockOn = vi.fn();

const mockApp = {
  use: mockUse,
  listen: mockListen.mockReturnValue({
    on: mockOn,
    address: vi.fn().mockReturnValue({ address: '0.0.0.0', port: 3005 }),
  }),
};

vi.mock('express', () => ({
  default: vi.fn().mockReturnValue(mockApp),
}));

vi.mock('body-parser', () => ({
  default: { json: vi.fn().mockReturnValue('bodyParserJson') },
}));

vi.mock('cors', () => ({
  default: vi.fn().mockReturnValue('corsMiddleware'),
}));

const { createReplayHandler } =
  await import('@lazyapps/command-processor/replayHandler.js');
const { startAdmin } = await import('../admin.js');

describe('startAdmin', () => {
  let eventStoreInstance;
  let storageInstance;
  let eventBusInstance;
  let backupInstance;
  let config;

  beforeEach(() => {
    vi.clearAllMocks();

    eventStoreInstance = {
      countEvents: vi.fn(),
      streamEvents: vi.fn(),
      getLatestEventTimestamp: vi.fn(),
    };

    storageInstance = {
      perRequest: vi.fn().mockReturnValue({
        find: vi.fn(),
        insertOne: vi.fn(),
      }),
      readLastProjectedEventTimestamps: vi.fn().mockResolvedValue(),
    };

    eventBusInstance = {
      publishReplayEvent: vi.fn(),
      publishSystemMessage: vi.fn(),
    };

    backupInstance = {
      createBackup: vi.fn(),
      listBackups: vi.fn(),
      restoreBackup: vi.fn(),
      deleteBackup: vi.fn(),
      clearCollections: vi.fn(),
      cleanupBackups: vi.fn(),
    };

    config = {
      port: 3005,
      eventStore: vi.fn().mockResolvedValue(eventStoreInstance),
      readModelStorage: vi.fn().mockResolvedValue(storageInstance),
      eventBus: vi.fn().mockResolvedValue(eventBusInstance),
      backup: vi.fn().mockReturnValue(backupInstance),
      readModels: { customers: { resolvers: { all: vi.fn() } } },
    };

    // Simulate server 'listening' event firing
    mockOn.mockImplementation((event, cb) => {
      if (event === 'listening') {
        setTimeout(() => cb(), 0);
      }
    });
  });

  test('initializes event store and read model storage', () =>
    startAdmin({ serviceId: 'TEST' }, config).then(() => {
      expect(config.eventStore).toHaveBeenCalledOnce();
      expect(config.readModelStorage).toHaveBeenCalledOnce();
    }));

  test('initializes event bus', () =>
    startAdmin({ serviceId: 'TEST' }, config).then(() => {
      expect(config.eventBus).toHaveBeenCalledOnce();
    }));

  test('creates replay handler from event store and event bus', () =>
    startAdmin({ serviceId: 'TEST' }, config).then(() => {
      expect(createReplayHandler).toHaveBeenCalledWith(
        eventStoreInstance,
        eventBusInstance,
      );
    }));

  test('initializes backup module with storage', () =>
    startAdmin({ serviceId: 'TEST' }, config).then(() => {
      expect(config.backup).toHaveBeenCalledWith(storageInstance);
    }));

  test('works without backup configured', () => {
    const configNoBackup = { ...config, backup: undefined };
    return startAdmin({ serviceId: 'TEST' }, configNoBackup).then(() => {
      expect(mockInstallReplayAdminApi).toHaveBeenCalledOnce();
    });
  });

  test('installs replay admin API routes', () =>
    startAdmin({ serviceId: 'TEST' }, config).then(() => {
      expect(mockInstallReplayAdminApi).toHaveBeenCalledOnce();
      const context = mockInstallReplayAdminApi.mock.calls[0][0];
      expect(context.replayHandler).toBe(mockReplayHandler);
    }));

  test('installs read model admin API routes', () =>
    startAdmin({ serviceId: 'TEST' }, config).then(() => {
      expect(mockInstallReadModelAdminApi).toHaveBeenCalledOnce();
      const context = mockInstallReadModelAdminApi.mock.calls[0][0];
      expect(context.readModels).toBe(config.readModels);
    }));

  test('context includes backup module', () =>
    startAdmin({ serviceId: 'TEST' }, config).then(() => {
      const context = mockInstallReadModelAdminApi.mock.calls[0][0];
      expect(context.backup).toBe(backupInstance);
    }));

  test('context includes projectionHandler with replay state tracking', () =>
    startAdmin({ serviceId: 'TEST' }, config).then(() => {
      const context = mockInstallReadModelAdminApi.mock.calls[0][0];
      expect(context.projectionHandler).toBeDefined();
      expect(context.projectionHandler.getReadModelReplayStates()).toEqual({});
      expect(context.projectionHandler.isReadModelReplaying('items')).toBe(
        false,
      );
      context.projectionHandler.setReadModelReplayState('items', true);
      expect(context.projectionHandler.isReadModelReplaying('items')).toBe(
        true,
      );
      expect(context.projectionHandler.getReadModelReplayStates()).toEqual({
        items: true,
      });
      context.projectionHandler.clearReadModelReplayState('items');
      expect(context.projectionHandler.isReadModelReplaying('items')).toBe(
        false,
      );
    }));

  test('starts express server on configured port', () =>
    startAdmin({ serviceId: 'TEST' }, config).then(() => {
      expect(mockListen).toHaveBeenCalledWith(3005, '0.0.0.0');
    }));

  test('uses default port 3005 when not specified', () => {
    const configNoPort = { ...config };
    delete configNoPort.port;
    return startAdmin({ serviceId: 'TEST' }, configNoPort).then(() => {
      expect(mockListen).toHaveBeenCalledWith(3005, '0.0.0.0');
    });
  });

  test('applies cors and body-parser middleware', () =>
    startAdmin({ serviceId: 'TEST' }, config).then(() => {
      expect(mockUse).toHaveBeenCalledWith('corsMiddleware');
      expect(mockUse).toHaveBeenCalledWith('bodyParserJson');
    }));

  test('resolves with the server instance', () =>
    startAdmin({ serviceId: 'TEST' }, config).then((server) => {
      expect(server).toBeDefined();
      expect(server.on).toBeDefined();
    }));

  test('calls readLastProjectedEventTimestamps when available', () =>
    startAdmin({ serviceId: 'TEST' }, config).then(() => {
      expect(
        storageInstance.readLastProjectedEventTimestamps,
      ).toHaveBeenCalledWith(config.readModels);
    }));

  test('works when storage has no readLastProjectedEventTimestamps', () => {
    const storageNoRead = {
      perRequest: vi.fn(),
    };
    const configNoRead = {
      ...config,
      readModelStorage: vi.fn().mockResolvedValue(storageNoRead),
    };
    return startAdmin({ serviceId: 'TEST' }, configNoRead).then(() => {
      expect(mockInstallReplayAdminApi).toHaveBeenCalledOnce();
    });
  });

  test('rejects when event store initialization fails', () => {
    const configBadES = {
      ...config,
      eventStore: vi.fn().mockRejectedValue(new Error('ES fail')),
    };
    return expect(
      startAdmin({ serviceId: 'TEST' }, configBadES),
    ).rejects.toThrow('ES fail');
  });

  test('rejects when server listen fails', () => {
    mockOn.mockImplementation((event, cb) => {
      if (event === 'error') {
        setTimeout(() => cb(new Error('port in use')), 0);
      }
    });
    return expect(startAdmin({ serviceId: 'TEST' }, config)).rejects.toThrow(
      'port in use',
    );
  });
});
