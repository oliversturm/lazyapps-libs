import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockInstallAdminRoutes = vi.fn().mockReturnValue(vi.fn());
const mockCreateSseClient = vi.fn().mockReturnValue({
  cache: {
    getAllReadModels: vi.fn().mockReturnValue({}),
    getReadModel: vi.fn(),
    getCommandProcessor: vi.fn().mockReturnValue({ state: 'idle' }),
    updateReadModel: vi.fn(),
  },
  emitter: { on: vi.fn(), off: vi.fn() },
  addBrowserClient: vi.fn().mockResolvedValue(undefined),
  removeBrowserClient: vi.fn(),
  startOperation: vi.fn().mockResolvedValue(undefined),
  endOperation: vi.fn(),
  ensureConnected: vi.fn().mockResolvedValue(undefined),
  disconnectAll: vi.fn(),
  waitForStatus: vi.fn(),
  fetchReplayRelevantEvents: vi.fn(),
  fetchBackupList: vi.fn(),
  fetchAllStatus: vi.fn().mockResolvedValue(undefined),
  getServiceUrls: vi.fn().mockReturnValue([]),
});
const mockCreateOrchestrator = vi.fn().mockReturnValue({
  replayOrchestration: vi.fn().mockResolvedValue({}),
  cancelReplayOrchestration: vi.fn().mockResolvedValue({}),
  activationOrchestration: vi.fn().mockResolvedValue({}),
  activateAll: vi.fn().mockResolvedValue([]),
});

vi.mock('@lazyapps/admin-api', () => ({
  installAdminRoutes: mockInstallAdminRoutes,
  createSseClient: mockCreateSseClient,
  createOrchestrator: mockCreateOrchestrator,
}));

const mockActivator = {
  autoActivateAll: vi.fn().mockResolvedValue(),
  fetchReadModels: vi.fn().mockResolvedValue([]),
};

vi.mock('../activator.js', () => ({
  createActivator: vi.fn().mockReturnValue(mockActivator),
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

const { startAdmin } = await import('../admin.js');

describe('startAdmin', () => {
  let eventBusInstance;
  let config;

  beforeEach(() => {
    vi.clearAllMocks();

    eventBusInstance = {
      publishAdminInstruction: vi.fn().mockReturnValue(vi.fn()),
    };

    config = {
      port: 3005,
      eventBus: vi.fn().mockResolvedValue(eventBusInstance),
      readModelServiceUrl: 'http://localhost:3002',
      commandProcessorUrl: 'http://localhost:3000',
    };

    // Simulate server 'listening' event firing
    mockOn.mockImplementation((event, cb) => {
      if (event === 'listening') {
        setTimeout(() => cb(), 0);
      }
    });
  });

  test('initializes message bus', () =>
    startAdmin({ serviceId: 'TEST' }, config).then(() => {
      expect(config.eventBus).toHaveBeenCalledOnce();
    }));

  test('creates SSE client with correct config', () =>
    startAdmin({ serviceId: 'TEST' }, config).then(() => {
      expect(mockCreateSseClient).toHaveBeenCalledWith({
        readModelServiceUrl: 'http://localhost:3002',
        commandProcessorUrl: 'http://localhost:3000',
        token: undefined,
      });
    }));

  test('creates orchestrator with SSE client and message bus', () =>
    startAdmin({ serviceId: 'TEST' }, config).then(() => {
      expect(mockCreateOrchestrator).toHaveBeenCalledWith(
        expect.objectContaining({
          eventBus: eventBusInstance,
        }),
      );
    }));

  test('installs admin routes', () =>
    startAdmin({ serviceId: 'TEST' }, config).then(() => {
      expect(mockInstallAdminRoutes).toHaveBeenCalledWith(
        expect.objectContaining({
          eventBus: eventBusInstance,
        }),
      );
    }));

  test('starts express server on configured port', () =>
    startAdmin({ serviceId: 'TEST' }, config).then(() => {
      expect(mockListen).toHaveBeenCalledWith(3005, '0.0.0.0');
    }));

  test('uses default port 3005 when not specified', () => {
    const { port, ...configNoPort } = config;
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

  test('rejects when message bus initialization fails', () => {
    const configBadEB = {
      ...config,
      eventBus: vi.fn().mockRejectedValue(new Error('EB fail')),
    };
    return expect(
      startAdmin({ serviceId: 'TEST' }, configBadEB),
    ).rejects.toThrow('EB fail');
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

  test('server __testing__ exposes sseClient and orchestrator', () =>
    startAdmin({ serviceId: 'TEST' }, config).then((server) => {
      expect(server.__testing__).toBeDefined();
      expect(server.__testing__.sseClient).toBeDefined();
      expect(server.__testing__.orchestrator).toBeDefined();
      expect(server.__testing__.eventBus).toBe(eventBusInstance);
    }));

  test('triggers auto-activation when autoActivate and readModelServiceUrl are set', () =>
    startAdmin({ serviceId: 'TEST' }, { ...config, autoActivate: true }).then(
      () => {
        expect(mockActivator.autoActivateAll).toHaveBeenCalled();
      },
    ));

  test('does not trigger auto-activation when autoActivate is falsy', () =>
    startAdmin({ serviceId: 'TEST' }, config).then(() => {
      expect(mockActivator.autoActivateAll).not.toHaveBeenCalled();
    }));

  test('does not eagerly connect SSE at startup', () =>
    startAdmin({ serviceId: 'TEST' }, config).then(() => {
      const sseClient = mockCreateSseClient.mock.results[0].value;
      expect(sseClient.ensureConnected).not.toHaveBeenCalled();
      expect(sseClient.addBrowserClient).not.toHaveBeenCalled();
      expect(sseClient.startOperation).not.toHaveBeenCalled();
    }));

  test('passes sseIdleGraceMs through to the SSE client as idleGraceMs', () =>
    startAdmin({ serviceId: 'TEST' }, { ...config, sseIdleGraceMs: 1234 }).then(
      () => {
        expect(mockCreateSseClient).toHaveBeenCalledWith(
          expect.objectContaining({ idleGraceMs: 1234 }),
        );
      },
    ));
});
