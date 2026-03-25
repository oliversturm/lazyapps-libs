import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('nanoid', () => ({
  nanoid: vi.fn().mockReturnValue('test-corr-id'),
}));

const { installAdminRoutes, createRoutes } = await import('../routes.js');

const mockReq = (body = {}, params = {}) => ({
  body,
  params,
  on: vi.fn(),
});

const mockRes = () => {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.writeHead = vi.fn();
  res.write = vi.fn();
  res.send = vi.fn().mockReturnValue(res);
  return res;
};

const createMockSseClient = () => ({
  cache: {
    getAllReadModels: vi.fn().mockReturnValue({
      'ep1/customers': {
        endpointName: 'ep1',
        readModelName: 'customers',
        state: 'live',
        lastProjectedEventTimestamp: 1000,
      },
    }),
    getReadModel: vi.fn().mockImplementation((ep, rm) => {
      if (ep === 'ep1' && rm === 'customers') {
        return {
          endpointName: 'ep1',
          readModelName: 'customers',
          state: 'live',
          lastProjectedEventTimestamp: 1000,
        };
      }
      return null;
    }),
    getCommandProcessor: vi.fn().mockReturnValue({
      state: 'idle',
      activeReplays: [],
      activeCatchUps: [],
    }),
  },
  emitter: {
    on: vi.fn(),
    off: vi.fn(),
  },
  addBrowserClient: vi.fn().mockResolvedValue(undefined),
  removeBrowserClient: vi.fn(),
  fetchBackupList: vi.fn().mockResolvedValue([]),
  fetchLastEventStoreTimestamp: vi.fn().mockResolvedValue(5000),
});

const createMockOrchestrator = () => ({
  replayOrchestration: vi.fn().mockResolvedValue({ status: 'live' }),
  cancelReplayOrchestration: vi.fn().mockResolvedValue({
    status: 'cancelling',
    correlationId: 'test-corr-id',
  }),
  activationOrchestration: vi.fn().mockResolvedValue({ status: 'live' }),
  activateAll: vi.fn().mockResolvedValue([]),
});

const createMockEventBus = () => ({
  publishAdminInstruction: vi.fn().mockReturnValue(vi.fn()),
});

describe('installAdminRoutes', () => {
  test('registers all admin routes on the app', () => {
    const app = { get: vi.fn(), post: vi.fn() };

    installAdminRoutes({
      sseClient: createMockSseClient(),
      orchestrator: createMockOrchestrator(),
      eventBus: createMockEventBus(),
      token: 'test',
    })(app);

    // Config
    expect(app.get).toHaveBeenCalledWith('/admin/config', expect.any(Function));

    // Status
    expect(app.get).toHaveBeenCalledWith(
      '/admin/readmodel/status',
      expect.any(Function),
    );
    expect(app.get).toHaveBeenCalledWith(
      '/admin/readmodel/status/:ep/:rm',
      expect.any(Function),
    );
    expect(app.get).toHaveBeenCalledWith(
      '/admin/commandprocessor/status',
      expect.any(Function),
    );
    expect(app.get).toHaveBeenCalledWith('/admin/events', expect.any(Function));

    // Replay
    expect(app.get).toHaveBeenCalledWith(
      '/admin/replay/preflight/:ep/:rm',
      expect.any(Function),
    );
    expect(app.post).toHaveBeenCalledWith(
      '/admin/replay/start/:ep/:rm',
      expect.any(Function),
    );
    expect(app.post).toHaveBeenCalledWith(
      '/admin/replay/cancel/:ep/:rm',
      expect.any(Function),
    );

    // Backup
    expect(app.post).toHaveBeenCalledWith(
      '/admin/backup/create/:ep/:rm',
      expect.any(Function),
    );
    expect(app.post).toHaveBeenCalledWith(
      '/admin/backup/cancel/:ep/:rm',
      expect.any(Function),
    );
    expect(app.post).toHaveBeenCalledWith(
      '/admin/backup/restore/:ep/:rm',
      expect.any(Function),
    );
    expect(app.post).toHaveBeenCalledWith(
      '/admin/backup/delete/:ep/:rm',
      expect.any(Function),
    );
    expect(app.get).toHaveBeenCalledWith(
      '/admin/backup/list/:ep/:rm',
      expect.any(Function),
    );

    // Lifecycle
    expect(app.post).toHaveBeenCalledWith(
      '/admin/readmodel/activate-all',
      expect.any(Function),
    );
    expect(app.post).toHaveBeenCalledWith(
      '/admin/readmodel/activate/:ep/:rm',
      expect.any(Function),
    );
    expect(app.post).toHaveBeenCalledWith(
      '/admin/readmodel/dismiss-invalid/:ep/:rm',
      expect.any(Function),
    );
    expect(app.post).toHaveBeenCalledWith(
      '/admin/readmodel/stop/:ep/:rm',
      expect.any(Function),
    );
    expect(app.post).toHaveBeenCalledWith(
      '/admin/readmodel/reset/:ep/:rm',
      expect.any(Function),
    );
  });
});

describe('createRoutes', () => {
  let sseClient;
  let orchestrator;
  let eventBus;
  let routes;

  beforeEach(() => {
    vi.clearAllMocks();
    sseClient = createMockSseClient();
    orchestrator = createMockOrchestrator();
    eventBus = createMockEventBus();
    routes = createRoutes({
      sseClient,
      orchestrator,
      eventBus,
      token: 'test-token',
    });
  });

  describe('readModelStatusAll', () => {
    test('returns all RM statuses from cache', () => {
      const req = mockReq();
      const res = mockRes();

      routes.readModelStatusAll(req, res);

      expect(sseClient.cache.getAllReadModels).toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith([
        expect.objectContaining({ readModelName: 'customers' }),
      ]);
    });
  });

  describe('readModelStatusOne', () => {
    test('returns specific RM status', () => {
      const req = mockReq({}, { ep: 'ep1', rm: 'customers' });
      const res = mockRes();

      routes.readModelStatusOne(req, res);

      expect(sseClient.cache.getReadModel).toHaveBeenCalledWith(
        'ep1',
        'customers',
      );
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'live' }),
      );
    });

    test('returns 404 for unknown RM', () => {
      const req = mockReq({}, { ep: 'ep1', rm: 'unknown' });
      const res = mockRes();

      routes.readModelStatusOne(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('commandProcessorStatus', () => {
    test('returns CP status from cache', () => {
      const req = mockReq();
      const res = mockRes();

      routes.commandProcessorStatus(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'idle' }),
      );
    });
  });

  describe('sseStream', () => {
    test('sets SSE headers and sends initial cache', () => {
      const req = mockReq();
      const res = mockRes();

      routes.sseStream(req, res);

      expect(res.writeHead).toHaveBeenCalledWith(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      expect(res.write).toHaveBeenCalledWith(':keepalive\n\n');
      // Should send initial RM and CP status
      expect(res.write).toHaveBeenCalledWith(
        expect.stringContaining('event: readmodel-status'),
      );
      expect(res.write).toHaveBeenCalledWith(
        expect.stringContaining('event: commandprocessor-status'),
      );
      expect(sseClient.addBrowserClient).toHaveBeenCalled();
    });

    test('removes client on close', () => {
      const req = mockReq();
      const res = mockRes();

      routes.sseStream(req, res);

      const closeHandler = req.on.mock.calls.find((c) => c[0] === 'close')[1];
      closeHandler();

      expect(sseClient.removeBrowserClient).toHaveBeenCalled();
      expect(sseClient.emitter.off).toHaveBeenCalledTimes(2);
    });
  });

  describe('replayPreflight', () => {
    test('returns preflight status with T=0 detection', () => {
      const req = mockReq({}, { ep: 'ep1', rm: 'customers' });
      const res = mockRes();

      return routes.replayPreflight(req, res).then(() => {
        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({
            found: true,
            tzero: false,
            lastProjectedEventTimestamp: 1000,
            lastEventStoreTimestamp: 5000,
          }),
        );
      });
    });

    test('returns 404 for unknown RM', () => {
      const req = mockReq({}, { ep: 'ep1', rm: 'unknown' });
      const res = mockRes();

      routes.replayPreflight(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    test('returns preflight even when event store fetch fails', () => {
      sseClient.fetchLastEventStoreTimestamp.mockRejectedValue(
        new Error('connection refused'),
      );

      const req = mockReq({}, { ep: 'ep1', rm: 'customers' });
      const res = mockRes();

      return routes.replayPreflight(req, res).then(() => {
        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({
            found: true,
            tzero: false,
            lastEventStoreTimestamp: null,
          }),
        );
      });
    });
  });

  describe('startReplay', () => {
    test('returns 202 and fires orchestration', () => {
      const req = mockReq({ autoBackup: true }, { ep: 'ep1', rm: 'customers' });
      const res = mockRes();

      routes.startReplay(req, res);

      expect(res.status).toHaveBeenCalledWith(202);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'started',
          endpointName: 'ep1',
          readModel: 'customers',
        }),
      );
      expect(orchestrator.replayOrchestration).toHaveBeenCalledWith(
        'ep1',
        'customers',
        expect.objectContaining({ autoBackup: true }),
      );
    });

    test('passes t0Option and customTimestamp to orchestrator', () => {
      const req = mockReq(
        {
          t0Option: 'customBoundary',
          customTimestamp: 4500,
          activateAfter: true,
        },
        { ep: 'ep1', rm: 'customers' },
      );
      const res = mockRes();

      routes.startReplay(req, res);

      expect(orchestrator.replayOrchestration).toHaveBeenCalledWith(
        'ep1',
        'customers',
        expect.objectContaining({
          t0Option: 'customBoundary',
          customTimestamp: 4500,
          activateAfter: true,
        }),
      );
    });

    test('passes skipReplayCatchUpOnly t0Option', () => {
      const req = mockReq(
        { t0Option: 'skipReplayCatchUpOnly' },
        { ep: 'ep1', rm: 'customers' },
      );
      const res = mockRes();

      routes.startReplay(req, res);

      expect(orchestrator.replayOrchestration).toHaveBeenCalledWith(
        'ep1',
        'customers',
        expect.objectContaining({
          t0Option: 'skipReplayCatchUpOnly',
        }),
      );
    });
  });

  describe('cancelReplay', () => {
    test('delegates to orchestrator cancel', () => {
      const req = mockReq({ reset: true }, { ep: 'ep1', rm: 'customers' });
      const res = mockRes();

      return routes.cancelReplay(req, res).then(() => {
        expect(orchestrator.cancelReplayOrchestration).toHaveBeenCalledWith(
          'ep1',
          'customers',
          { reset: true },
        );
        expect(res.json).toHaveBeenCalledWith(
          expect.objectContaining({ status: 'cancelling' }),
        );
      });
    });
  });

  describe('createBackup', () => {
    test('publishes createBackup command and returns 202', () => {
      const publishFn = vi.fn();
      eventBus.publishAdminInstruction.mockReturnValue(publishFn);

      const req = mockReq({}, { ep: 'ep1', rm: 'customers' });
      const res = mockRes();

      routes.createBackup(req, res);

      expect(eventBus.publishAdminInstruction).toHaveBeenCalledWith(
        'test-corr-id',
      );
      expect(publishFn).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'createBackup',
          targetEndpointName: 'ep1',
          targetReadModel: 'customers',
        }),
      );
      expect(res.status).toHaveBeenCalledWith(202);
    });

    test('returns 404 for unknown RM', () => {
      const req = mockReq({}, { ep: 'ep1', rm: 'unknown' });
      const res = mockRes();

      routes.createBackup(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(eventBus.publishAdminInstruction).not.toHaveBeenCalled();
    });
  });

  describe('restoreBackup', () => {
    test('returns 400 if backupId missing', () => {
      const req = mockReq({}, { ep: 'ep1', rm: 'customers' });
      const res = mockRes();

      routes.restoreBackup(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('publishes restoreBackup command', () => {
      const publishFn = vi.fn();
      eventBus.publishAdminInstruction.mockReturnValue(publishFn);

      const req = mockReq({ backupId: 'b1' }, { ep: 'ep1', rm: 'customers' });
      const res = mockRes();

      routes.restoreBackup(req, res);

      expect(publishFn).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'restoreBackup',
          backupId: 'b1',
        }),
      );
      expect(res.status).toHaveBeenCalledWith(202);
    });
  });

  describe('deleteBackup', () => {
    test('returns 400 if backupId missing', () => {
      const req = mockReq({}, { ep: 'ep1', rm: 'customers' });
      const res = mockRes();

      routes.deleteBackup(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  describe('listBackups', () => {
    test('proxies to sseClient.fetchBackupList', () => {
      sseClient.fetchBackupList.mockResolvedValue([
        { backupId: 'b1', timestamp: 100 },
      ]);

      const req = mockReq({}, { ep: 'ep1', rm: 'customers' });
      const res = mockRes();

      return routes.listBackups(req, res).then(() => {
        expect(sseClient.fetchBackupList).toHaveBeenCalledWith(
          'ep1',
          'customers',
        );
        expect(res.json).toHaveBeenCalledWith([
          { backupId: 'b1', timestamp: 100 },
        ]);
      });
    });

    test('returns 502 on proxy failure', () => {
      sseClient.fetchBackupList.mockRejectedValue(
        new Error('connection refused'),
      );

      const req = mockReq({}, { ep: 'ep1', rm: 'customers' });
      const res = mockRes();

      return routes.listBackups(req, res).then(() => {
        expect(res.status).toHaveBeenCalledWith(502);
      });
    });
  });

  describe('activateAllRms', () => {
    test('returns 202 with readModels list', () => {
      const req = mockReq();
      const res = mockRes();

      routes.activateAllRms(req, res);

      expect(orchestrator.activateAll).toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(202);
      expect(res.json).toHaveBeenCalledWith({
        status: 'activating',
        readModels: ['ep1/customers'],
      });
    });
  });

  describe('activateRm', () => {
    test('returns 202 and fires activation', () => {
      const req = mockReq({}, { ep: 'ep1', rm: 'customers' });
      const res = mockRes();

      routes.activateRm(req, res);

      expect(orchestrator.activationOrchestration).toHaveBeenCalledWith(
        'ep1',
        'customers',
      );
      expect(res.status).toHaveBeenCalledWith(202);
    });
  });

  describe('stopRm', () => {
    test('publishes stop command', () => {
      const publishFn = vi.fn();
      eventBus.publishAdminInstruction.mockReturnValue(publishFn);

      const req = mockReq({}, { ep: 'ep1', rm: 'customers' });
      const res = mockRes();

      routes.stopRm(req, res);

      expect(publishFn).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'stop',
          targetEndpointName: 'ep1',
          targetReadModel: 'customers',
        }),
      );
    });

    test('returns 404 for unknown RM', () => {
      const req = mockReq({}, { ep: 'ep1', rm: 'unknown' });
      const res = mockRes();

      routes.stopRm(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(eventBus.publishAdminInstruction).not.toHaveBeenCalled();
    });
  });

  describe('resetRm', () => {
    test('publishes reset command', () => {
      const publishFn = vi.fn();
      eventBus.publishAdminInstruction.mockReturnValue(publishFn);

      const req = mockReq({}, { ep: 'ep1', rm: 'customers' });
      const res = mockRes();

      routes.resetRm(req, res);

      expect(publishFn).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'reset',
          targetEndpointName: 'ep1',
          targetReadModel: 'customers',
        }),
      );
    });

    test('returns 404 for unknown RM', () => {
      const req = mockReq({}, { ep: 'ep1', rm: 'unknown' });
      const res = mockRes();

      routes.resetRm(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(eventBus.publishAdminInstruction).not.toHaveBeenCalled();
    });
  });

  describe('adminConfig', () => {
    test('returns developmentMode false by default', () => {
      const req = mockReq();
      const res = mockRes();

      routes.adminConfig(req, res);

      expect(res.json).toHaveBeenCalledWith({ developmentMode: false });
    });

    test('returns developmentMode true when configured', () => {
      const devRoutes = createRoutes({
        sseClient,
        orchestrator,
        eventBus,
        token: 'test-token',
        developmentMode: true,
      });
      const req = mockReq();
      const res = mockRes();

      devRoutes.adminConfig(req, res);

      expect(res.json).toHaveBeenCalledWith({ developmentMode: true });
    });
  });

  describe('validateFilter', () => {
    test('returns 400 when filterString is missing', () => {
      const req = mockReq({});
      const res = mockRes();

      routes.validateFilter(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        filter: null,
        error: 'filterString is required',
      });
    });

    test('returns 400 when body is null', () => {
      const req = mockReq(null);
      const res = mockRes();

      routes.validateFilter(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('returns parsed filter for valid IncludeByName', () => {
      const req = mockReq({
        filterString: "IncludeByName('sendEmail')",
      });
      const res = mockRes();

      routes.validateFilter(req, res);

      expect(res.json).toHaveBeenCalledWith({
        filter: {
          byName: { type: 'include', names: ['sendEmail'] },
        },
        error: null,
      });
    });

    test('returns parsed filter for valid ExcludeByName', () => {
      const req = mockReq({
        filterString: "ExcludeByName('sendEmail', 'sendWebhook')",
      });
      const res = mockRes();

      routes.validateFilter(req, res);

      expect(res.json).toHaveBeenCalledWith({
        filter: {
          byName: {
            type: 'exclude',
            names: ['sendEmail', 'sendWebhook'],
          },
        },
        error: null,
      });
    });

    test('returns error for invalid filter syntax', () => {
      const req = mockReq({ filterString: 'InvalidFilter(abc)' });
      const res = mockRes();

      routes.validateFilter(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: null,
          error: expect.any(String),
        }),
      );
    });

    test('returns error for empty filter string', () => {
      const req = mockReq({ filterString: '' });
      const res = mockRes();

      routes.validateFilter(req, res);

      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: null,
          error: expect.any(String),
        }),
      );
    });

    test('returns combined filter for ByName && Command', () => {
      const req = mockReq({
        filterString:
          "IncludeByName('sendEmail') && ExcludeCommand('deleteUser')",
      });
      const res = mockRes();

      routes.validateFilter(req, res);

      const result = res.json.mock.calls[0][0];
      expect(result.error).toBeNull();
      expect(result.filter).toBeDefined();
      expect(result.filter.byName).toEqual({
        type: 'include',
        names: ['sendEmail'],
      });
      expect(result.filter.byCommand).toEqual({
        type: 'exclude',
        commands: ['deleteUser'],
      });
    });
  });

  describe('dismissInvalid', () => {
    test('returns 403 when not in dev mode', () => {
      const req = mockReq({}, { ep: 'ep1', rm: 'customers' });
      const res = mockRes();

      routes.dismissInvalid(req, res);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(eventBus.publishAdminInstruction).not.toHaveBeenCalled();
    });

    test('publishes dismissInvalid command in dev mode', () => {
      const devRoutes = createRoutes({
        sseClient,
        orchestrator,
        eventBus,
        token: 'test-token',
        developmentMode: true,
      });
      const publishFn = vi.fn();
      eventBus.publishAdminInstruction.mockReturnValue(publishFn);

      const req = mockReq({}, { ep: 'ep1', rm: 'customers' });
      const res = mockRes();

      devRoutes.dismissInvalid(req, res);

      expect(publishFn).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'dismissInvalid',
          targetEndpointName: 'ep1',
          targetReadModel: 'customers',
          developmentOperation: true,
        }),
      );
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'dismissing' }),
      );
    });

    test('returns 404 for unknown RM in dev mode', () => {
      const devRoutes = createRoutes({
        sseClient,
        orchestrator,
        eventBus,
        token: 'test-token',
        developmentMode: true,
      });
      const req = mockReq({}, { ep: 'ep1', rm: 'unknown' });
      const res = mockRes();

      devRoutes.dismissInvalid(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(eventBus.publishAdminInstruction).not.toHaveBeenCalled();
    });
  });
});
