import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { installAdminEndpoints } = await import('../adminEndpoints.js');

const createMockApp = () => {
  const routes = {};
  return {
    get: vi.fn((path, ...handlers) => {
      routes[`GET ${path}`] = handlers;
    }),
    routes,
  };
};

const createMockRes = () => ({
  status: vi.fn().mockReturnThis(),
  json: vi.fn(),
  writeHead: vi.fn(),
  write: vi.fn(),
});

const createMockReq = (params = {}, headers = {}) => ({
  params,
  headers,
  on: vi.fn(),
});

describe('adminEndpoints', () => {
  let context;
  let app;

  beforeEach(() => {
    vi.clearAllMocks();
    context = {
      endpointName: 'ep1',
      expectedAdminToken: 'test-token',
      readModels: {
        customers: {
          projections: { CUSTOMER_CREATED: () => {} },
          resolvers: { all: () => {} },
          replayRelevantEvents: ['CUSTOMER_CREATED'],
        },
        orders: {
          projections: { ORDER_PLACED: () => {} },
          resolvers: { all: () => {} },
        },
      },
      statusTracker: {
        addSseClient: vi.fn(),
        removeSseClient: vi.fn(),
        getStatus: vi.fn().mockReturnValue({
          endpointName: 'ep1',
          readModelName: 'customers',
          state: 'live',
          lastProjectedEventTimestamp: 500,
        }),
      },
    };
    app = createMockApp();
    installAdminEndpoints(context, app);
  });

  describe('route installation', () => {
    test('installs SSE endpoint', () => {
      expect(app.get).toHaveBeenCalledWith(
        '/admin/events/:ep',
        expect.any(Function),
        expect.any(Function),
      );
    });

    test('installs status endpoint', () => {
      expect(app.get).toHaveBeenCalledWith(
        '/admin/status/:ep/:rm',
        expect.any(Function),
        expect.any(Function),
      );
    });

    test('installs replayRelevantEvents endpoint', () => {
      expect(app.get).toHaveBeenCalledWith(
        '/admin/replayRelevantEvents/:ep/:rm',
        expect.any(Function),
        expect.any(Function),
      );
    });

    test('installs readmodel list endpoint', () => {
      expect(app.get).toHaveBeenCalledWith(
        '/admin/readmodel',
        expect.any(Function),
        expect.any(Function),
      );
    });

    test('installs backup list endpoint', () => {
      expect(app.get).toHaveBeenCalledWith(
        '/admin/backup/list/:ep/:rm',
        expect.any(Function),
        expect.any(Function),
      );
    });
  });

  describe('token auth', () => {
    test('rejects request without authorization header', () => {
      const handlers = app.routes['GET /admin/status/:ep/:rm'];
      const authMiddleware = handlers[0];
      const req = createMockReq({ ep: 'ep1', rm: 'customers' });
      const res = createMockRes();
      const next = vi.fn();

      authMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });

    test('rejects request with wrong token', () => {
      const handlers = app.routes['GET /admin/status/:ep/:rm'];
      const authMiddleware = handlers[0];
      const req = createMockReq(
        { ep: 'ep1', rm: 'customers' },
        { authorization: 'Bearer wrong-token' },
      );
      const res = createMockRes();
      const next = vi.fn();

      authMiddleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });

    test('allows request with correct token', () => {
      const handlers = app.routes['GET /admin/status/:ep/:rm'];
      const authMiddleware = handlers[0];
      const req = createMockReq(
        { ep: 'ep1', rm: 'customers' },
        { authorization: 'Bearer test-token' },
      );
      const res = createMockRes();
      const next = vi.fn();

      authMiddleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    test('skips auth when no expectedAdminToken configured', () => {
      context.expectedAdminToken = null;
      const noAuthApp = createMockApp();
      installAdminEndpoints(context, noAuthApp);

      const handlers = noAuthApp.routes['GET /admin/status/:ep/:rm'];
      const authMiddleware = handlers[0];
      const req = createMockReq({ ep: 'ep1', rm: 'customers' });
      const res = createMockRes();
      const next = vi.fn();

      authMiddleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('GET /admin/status/:ep/:rm', () => {
    const getHandler = () => {
      const handlers = app.routes['GET /admin/status/:ep/:rm'];
      return handlers[handlers.length - 1];
    };

    test('returns status for known read model', () => {
      const handler = getHandler();
      const req = createMockReq({ ep: 'ep1', rm: 'customers' });
      const res = createMockRes();

      handler(req, res);

      expect(context.statusTracker.getStatus).toHaveBeenCalledWith('customers');
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'live' }),
      );
    });

    test('returns 404 for wrong endpoint', () => {
      const handler = getHandler();
      const req = createMockReq({ ep: 'wrong-ep', rm: 'customers' });
      const res = createMockRes();

      handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    test('returns 404 for unknown read model', () => {
      context.statusTracker.getStatus.mockReturnValue(null);
      const handler = getHandler();
      const req = createMockReq({ ep: 'ep1', rm: 'nonexistent' });
      const res = createMockRes();

      handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('GET /admin/replayRelevantEvents/:ep/:rm', () => {
    const getHandler = () => {
      const handlers = app.routes['GET /admin/replayRelevantEvents/:ep/:rm'];
      return handlers[handlers.length - 1];
    };

    test('returns replayRelevantEvents array', () => {
      const handler = getHandler();
      const req = createMockReq({ ep: 'ep1', rm: 'customers' });
      const res = createMockRes();

      handler(req, res);

      expect(res.json).toHaveBeenCalledWith(['CUSTOMER_CREATED']);
    });

    test('returns 400 when replayRelevantEvents not configured', () => {
      const handler = getHandler();
      const req = createMockReq({ ep: 'ep1', rm: 'orders' });
      const res = createMockRes();

      handler(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
    });

    test('returns 404 for unknown read model', () => {
      const handler = getHandler();
      const req = createMockReq({ ep: 'ep1', rm: 'nonexistent' });
      const res = createMockRes();

      handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    test('returns 404 for wrong endpoint', () => {
      const handler = getHandler();
      const req = createMockReq({ ep: 'wrong-ep', rm: 'customers' });
      const res = createMockRes();

      handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('GET /admin/readmodel', () => {
    const getHandler = () => {
      const handlers = app.routes['GET /admin/readmodel'];
      return handlers[handlers.length - 1];
    };

    test('returns all read model statuses', () => {
      context.statusTracker.getAllStatuses = vi.fn().mockReturnValue([
        {
          endpointName: 'ep1',
          readModelName: 'customers',
          state: 'live',
          lastProjectedEventTimestamp: 500,
        },
        {
          endpointName: 'ep1',
          readModelName: 'orders',
          state: 'stopped',
          lastProjectedEventTimestamp: 0,
        },
      ]);
      const handler = getHandler();
      const req = createMockReq();
      const res = createMockRes();

      handler(req, res);

      expect(res.json).toHaveBeenCalledWith([
        {
          name: 'customers',
          endpointName: 'ep1',
          state: 'live',
          lastProjectedEventTimestamp: 500,
        },
        {
          name: 'orders',
          endpointName: 'ep1',
          state: 'stopped',
          lastProjectedEventTimestamp: 0,
        },
      ]);
    });
  });

  describe('GET /admin/backup/list/:ep/:rm', () => {
    const getHandler = () => {
      const handlers = app.routes['GET /admin/backup/list/:ep/:rm'];
      return handlers[handlers.length - 1];
    };

    test('returns empty array when backup not configured', () => {
      const handler = getHandler();
      const req = createMockReq({ ep: 'ep1', rm: 'customers' });
      const res = createMockRes();

      handler(req, res);

      expect(res.json).toHaveBeenCalledWith([]);
    });

    test('returns backup list when backup configured', async () => {
      const backups = [{ backupId: 'b1', timestamp: 100 }];
      context.backup = {
        listBackups: vi.fn().mockResolvedValue(backups),
      };
      // Reinstall with backup context
      const backupApp = createMockApp();
      installAdminEndpoints(context, backupApp);
      const handlers = backupApp.routes['GET /admin/backup/list/:ep/:rm'];
      const handler = handlers[handlers.length - 1];
      const req = createMockReq({ ep: 'ep1', rm: 'customers' });
      const res = createMockRes();

      handler(req, res);
      await vi.waitFor(() => {
        expect(context.backup.listBackups).toHaveBeenCalledWith('customers');
        expect(res.json).toHaveBeenCalledWith(backups);
      });
    });

    test('returns 404 for wrong endpoint', () => {
      const handler = getHandler();
      const req = createMockReq({ ep: 'wrong-ep', rm: 'customers' });
      const res = createMockRes();

      handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });

    test('returns 404 for unknown read model', () => {
      const handler = getHandler();
      const req = createMockReq({ ep: 'ep1', rm: 'nonexistent' });
      const res = createMockRes();

      handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });

  describe('GET /admin/events/:ep', () => {
    const getHandler = () => {
      const handlers = app.routes['GET /admin/events/:ep'];
      return handlers[handlers.length - 1];
    };

    test('sets up SSE response headers', () => {
      const handler = getHandler();
      const req = createMockReq({ ep: 'ep1' });
      const res = createMockRes();

      handler(req, res);

      expect(res.writeHead).toHaveBeenCalledWith(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
    });

    test('writes keepalive and adds SSE client', () => {
      const handler = getHandler();
      const req = createMockReq({ ep: 'ep1' });
      const res = createMockRes();

      handler(req, res);

      expect(res.write).toHaveBeenCalledWith(':keepalive\n\n');
      expect(context.statusTracker.addSseClient).toHaveBeenCalledWith(res);
    });

    test('removes SSE client on close', () => {
      const handler = getHandler();
      const req = createMockReq({ ep: 'ep1' });
      const res = createMockRes();

      handler(req, res);

      // Get the close handler registered on req
      const closeHandler = req.on.mock.calls.find(
        ([event]) => event === 'close',
      )[1];
      closeHandler();

      expect(context.statusTracker.removeSseClient).toHaveBeenCalledWith(res);
    });

    test('returns 404 for wrong endpoint', () => {
      const handler = getHandler();
      const req = createMockReq({ ep: 'wrong-ep' });
      const res = createMockRes();

      handler(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
    });
  });
});
