import { describe, test, expect, vi } from 'vitest';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('nanoid', () => ({
  nanoid: vi.fn().mockReturnValue('test-corr-id'),
}));

const {
  installReplayAdminApi,
  installCatchupAdminApi,
  installReadModelAdminApi,
  installAdminEventsApi,
} = await import('../index.js');

describe('installReplayAdminApi', () => {
  test('registers command processor admin routes', () => {
    const context = {};
    const app = {
      post: vi.fn(),
      get: vi.fn(),
    };

    installReplayAdminApi(context)(app);

    expect(app.post).toHaveBeenCalledWith(
      '/api/admin/startReplay',
      expect.any(Function),
    );
    expect(app.get).toHaveBeenCalledWith(
      '/api/admin/replayStatus/:endpointName/:readModel',
      expect.any(Function),
    );
    expect(app.post).toHaveBeenCalledWith(
      '/api/admin/cancelReplay',
      expect.any(Function),
    );
    expect(app.post).toHaveBeenCalledWith(
      '/api/admin/commandReplayState',
      expect.any(Function),
    );
    expect(app.post).toHaveBeenCalledTimes(3);
    expect(app.get).toHaveBeenCalledTimes(1);
  });
});

describe('installReadModelAdminApi', () => {
  test('registers read model admin routes', () => {
    const context = {};
    const app = {
      post: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
    };

    installReadModelAdminApi(context)(app);

    expect(app.get).toHaveBeenCalledWith('/admin/status', expect.any(Function));
    expect(app.get).toHaveBeenCalledWith(
      '/admin/readmodels',
      expect.any(Function),
    );
    expect(app.post).toHaveBeenCalledWith(
      '/admin/backup/:endpointName/:readModelName',
      expect.any(Function),
    );
    expect(app.get).toHaveBeenCalledWith(
      '/admin/backups/:endpointName/:readModelName',
      expect.any(Function),
    );
    expect(app.delete).toHaveBeenCalledWith(
      '/admin/backup/:backupId',
      expect.any(Function),
    );
    expect(app.post).toHaveBeenCalledWith(
      '/admin/replay/:endpointName/:readModelName/prepare',
      expect.any(Function),
    );
    expect(app.get).toHaveBeenCalledWith(
      '/admin/replay/:endpointName/:readModelName/status',
      expect.any(Function),
    );
    expect(app.delete).toHaveBeenCalledWith(
      '/admin/replay/:endpointName/:readModelName/state',
      expect.any(Function),
    );
    expect(app.post).toHaveBeenCalledWith(
      '/admin/readmodels/:endpointName/:readModelName/activate',
      expect.any(Function),
    );
    expect(app.post).toHaveBeenCalledWith(
      '/admin/readmodels/:endpointName/:readModelName/stop',
      expect.any(Function),
    );
    expect(app.post).toHaveBeenCalledWith(
      '/admin/readmodels/activate-all',
      expect.any(Function),
    );
    expect(app.post).toHaveBeenCalledTimes(5);
    expect(app.get).toHaveBeenCalledTimes(4);
    expect(app.delete).toHaveBeenCalledTimes(2);
  });
});

describe('installAdminEventsApi', () => {
  test('registers GET /api/admin/events route', () => {
    const context = { sseClients: new Set() };
    const app = { get: vi.fn() };

    installAdminEventsApi(context)(app);

    expect(app.get).toHaveBeenCalledWith(
      '/api/admin/events',
      expect.any(Function),
    );
    expect(app.get).toHaveBeenCalledTimes(1);
  });

  test('sets SSE headers and writes keepalive comment', () => {
    const context = { sseClients: new Set() };
    const app = { get: vi.fn() };

    installAdminEventsApi(context)(app);

    const handler = app.get.mock.calls[0][1];
    const req = { on: vi.fn() };
    const res = { writeHead: vi.fn(), write: vi.fn() };

    handler(req, res);

    expect(res.writeHead).toHaveBeenCalledWith(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    expect(res.write).toHaveBeenCalledWith(':keepalive\n\n');
  });

  test('adds response to sseClients and removes on close', () => {
    const context = { sseClients: new Set() };
    const app = { get: vi.fn() };

    installAdminEventsApi(context)(app);

    const handler = app.get.mock.calls[0][1];
    const req = { on: vi.fn() };
    const res = { writeHead: vi.fn(), write: vi.fn() };

    handler(req, res);

    expect(context.sseClients.has(res)).toBe(true);
    expect(context.sseClients.size).toBe(1);

    // Simulate close event
    const closeHandler = req.on.mock.calls.find((c) => c[0] === 'close')[1];
    closeHandler();

    expect(context.sseClients.has(res)).toBe(false);
    expect(context.sseClients.size).toBe(0);
  });
});

describe('installCatchupAdminApi', () => {
  test('registers catch-up admin routes', () => {
    const context = {};
    const app = {
      post: vi.fn(),
      get: vi.fn(),
    };

    installCatchupAdminApi(context)(app);

    expect(app.post).toHaveBeenCalledWith(
      '/admin/catchup/:endpointName/:readModelName/start',
      expect.any(Function),
    );
    expect(app.post).toHaveBeenCalledWith(
      '/admin/catchup/:endpointName/:readModelName/cancel',
      expect.any(Function),
    );
    expect(app.get).toHaveBeenCalledWith(
      '/admin/catchup/:endpointName/:readModelName/status',
      expect.any(Function),
    );
    expect(app.post).toHaveBeenCalledTimes(2);
    expect(app.get).toHaveBeenCalledTimes(1);
  });
});
