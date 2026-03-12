import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const mockInstallReplayAdminApi = vi.fn().mockReturnValue(vi.fn());
const mockInstallCatchupAdminApi = vi.fn().mockReturnValue(vi.fn());
const mockInstallReadModelAdminApi = vi.fn().mockReturnValue(vi.fn());

vi.mock('@lazyapps/admin-api', () => ({
  installReplayAdminApi: mockInstallReplayAdminApi,
  installCatchupAdminApi: mockInstallCatchupAdminApi,
  installReadModelAdminApi: mockInstallReadModelAdminApi,
}));

const mockActivator = {
  activateReadModel: vi.fn().mockResolvedValue(),
  stopReadModel: vi.fn(),
  restartReadModel: vi.fn().mockResolvedValue(),
  queryReadModelState: vi.fn().mockResolvedValue({}),
  signalCpReady: vi.fn().mockResolvedValue(),
  autoActivateAll: vi.fn().mockResolvedValue(),
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
      publishReplayEvent: vi.fn(),
      publishSystemMessage: vi.fn(),
    };

    config = {
      port: 3005,
      eventBus: vi.fn().mockResolvedValue(eventBusInstance),
      readModels: { customers: { resolvers: { all: vi.fn() } } },
    };

    // Simulate server 'listening' event firing
    mockOn.mockImplementation((event, cb) => {
      if (event === 'listening') {
        setTimeout(() => cb(), 0);
      }
    });
  });

  test('initializes event bus', () =>
    startAdmin({ serviceId: 'TEST' }, config).then(() => {
      expect(config.eventBus).toHaveBeenCalledOnce();
    }));

  test('installs replay admin API routes', () =>
    startAdmin({ serviceId: 'TEST' }, config).then(() => {
      expect(mockInstallReplayAdminApi).toHaveBeenCalledOnce();
      const context = mockInstallReplayAdminApi.mock.calls[0][0];
      expect(context.eventBus).toBe(eventBusInstance);
    }));

  test('installs read model admin API routes', () =>
    startAdmin({ serviceId: 'TEST' }, config).then(() => {
      expect(mockInstallReadModelAdminApi).toHaveBeenCalledOnce();
      const context = mockInstallReadModelAdminApi.mock.calls[0][0];
      expect(context.readModels).toBe(config.readModels);
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

  test('rejects when event bus initialization fails', () => {
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

  test('context includes activator for orchestration', () =>
    startAdmin({ serviceId: 'TEST' }, config).then(() => {
      const context = mockInstallReadModelAdminApi.mock.calls[0][0];
      expect(context.activator).toBeDefined();
      expect(context.activator.activateReadModel).toBeInstanceOf(Function);
      expect(context.activator.stopReadModel).toBeInstanceOf(Function);
      expect(context.activator.signalCpReady).toBeInstanceOf(Function);
    }));

  test('subscribes to system messages when available', () => {
    const subscribeSystemMessages = vi.fn();
    eventBusInstance.subscribeSystemMessages = subscribeSystemMessages;
    return startAdmin({ serviceId: 'TEST' }, config).then(() => {
      expect(subscribeSystemMessages).toHaveBeenCalledOnce();
    });
  });

  test('subscribes to admin messages when available', () => {
    const subscribeAdminMessages = vi.fn();
    eventBusInstance.subscribeAdminMessages = subscribeAdminMessages;
    return startAdmin({ serviceId: 'TEST' }, config).then(() => {
      expect(subscribeAdminMessages).toHaveBeenCalledOnce();
    });
  });

  test('clears replay state on REPLAY_EVENTS_DONE system message', () => {
    let systemHandler;
    eventBusInstance.subscribeSystemMessages = vi
      .fn()
      .mockImplementation((handler) => {
        systemHandler = handler;
      });
    return startAdmin({ serviceId: 'TEST' }, config).then(() => {
      const context = mockInstallReadModelAdminApi.mock.calls[0][0];
      context.projectionHandler.setReadModelReplayState('items', true);
      expect(context.projectionHandler.isReadModelReplaying('items')).toBe(
        true,
      );
      systemHandler({ type: 'REPLAY_EVENTS_DONE', readModel: 'items' });
      expect(context.projectionHandler.isReadModelReplaying('items')).toBe(
        false,
      );
    });
  });

  test('clears replay state on REPLAY_CANCELLED system message', () => {
    let systemHandler;
    eventBusInstance.subscribeSystemMessages = vi
      .fn()
      .mockImplementation((handler) => {
        systemHandler = handler;
      });
    return startAdmin({ serviceId: 'TEST' }, config).then(() => {
      const context = mockInstallReadModelAdminApi.mock.calls[0][0];
      context.projectionHandler.setReadModelReplayState('items', true);
      systemHandler({ type: 'REPLAY_CANCELLED', readModel: 'items' });
      expect(context.projectionHandler.isReadModelReplaying('items')).toBe(
        false,
      );
    });
  });

  test('sets terminal status to completed on REPLAY_EVENTS_DONE', () => {
    let systemHandler;
    eventBusInstance.subscribeSystemMessages = vi
      .fn()
      .mockImplementation((handler) => {
        systemHandler = handler;
      });
    return startAdmin({ serviceId: 'TEST' }, config).then(() => {
      const context = mockInstallReadModelAdminApi.mock.calls[0][0];
      context.projectionHandler.setReadModelReplayState('items', true);
      systemHandler({ type: 'REPLAY_EVENTS_DONE', readModel: 'items' });
      expect(
        context.projectionHandler.getReadModelTerminalStatus('items'),
      ).toBe('completed');
    });
  });

  test('sets terminal status to cancelled on REPLAY_CANCELLED', () => {
    let systemHandler;
    eventBusInstance.subscribeSystemMessages = vi
      .fn()
      .mockImplementation((handler) => {
        systemHandler = handler;
      });
    return startAdmin({ serviceId: 'TEST' }, config).then(() => {
      const context = mockInstallReadModelAdminApi.mock.calls[0][0];
      context.projectionHandler.setReadModelReplayState('items', true);
      systemHandler({ type: 'REPLAY_CANCELLED', readModel: 'items' });
      expect(
        context.projectionHandler.getReadModelTerminalStatus('items'),
      ).toBe('cancelled');
    });
  });

  test('sets terminal status to completed on CATCHUP_EVENTS_DONE', () => {
    let systemHandler;
    eventBusInstance.subscribeSystemMessages = vi
      .fn()
      .mockImplementation((handler) => {
        systemHandler = handler;
      });
    return startAdmin({ serviceId: 'TEST' }, config).then(() => {
      const context = mockInstallReadModelAdminApi.mock.calls[0][0];
      systemHandler({ type: 'CATCHUP_EVENTS_DONE', readModel: 'items' });
      expect(
        context.projectionHandler.getReadModelTerminalStatus('items'),
      ).toBe('completed');
    });
  });

  test('sets terminal status to cancelled on CATCHUP_CANCELLED', () => {
    let systemHandler;
    eventBusInstance.subscribeSystemMessages = vi
      .fn()
      .mockImplementation((handler) => {
        systemHandler = handler;
      });
    return startAdmin({ serviceId: 'TEST' }, config).then(() => {
      const context = mockInstallReadModelAdminApi.mock.calls[0][0];
      systemHandler({ type: 'CATCHUP_CANCELLED', readModel: 'items' });
      expect(
        context.projectionHandler.getReadModelTerminalStatus('items'),
      ).toBe('cancelled');
    });
  });

  test('setReadModelReplayState clears terminal status', () => {
    let systemHandler;
    eventBusInstance.subscribeSystemMessages = vi
      .fn()
      .mockImplementation((handler) => {
        systemHandler = handler;
      });
    return startAdmin({ serviceId: 'TEST' }, config).then(() => {
      const context = mockInstallReadModelAdminApi.mock.calls[0][0];
      context.projectionHandler.setReadModelReplayState('items', true);
      systemHandler({ type: 'REPLAY_EVENTS_DONE', readModel: 'items' });
      expect(
        context.projectionHandler.getReadModelTerminalStatus('items'),
      ).toBe('completed');
      context.projectionHandler.setReadModelReplayState('items', true);
      expect(
        context.projectionHandler.getReadModelTerminalStatus('items'),
      ).toBe(null);
    });
  });
});
