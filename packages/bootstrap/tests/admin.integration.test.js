import { describe, test, expect, vi, beforeAll, afterAll } from 'vitest';
import expressApp from 'express';
import bodyParser from 'body-parser';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { startAdmin } = await import('../admin.js');

describe('startAdmin integration', { timeout: 30000 }, () => {
  let server;
  let adminPort;
  let mockRmServer;
  let mockRmPort;
  let mockCpServer;
  let mockCpPort;
  let publishedCommands;

  // Mock RM HTTP service
  const startMockRmService = () =>
    new Promise((resolve) => {
      const app = expressApp();
      app.use(bodyParser.json());

      app.get('/admin/readmodel', (req, res) => {
        res.json([
          {
            name: 'customers',
            endpointName: 'ep1',
            state: 'idle',
            lastProjectedEventTimestamp: 1000,
          },
          {
            name: 'orders',
            endpointName: 'ep1',
            state: 'idle',
            lastProjectedEventTimestamp: 2000,
          },
        ]);
      });

      app.get('/admin/events/:ep', (req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(':keepalive\n\n');
        // Keep connection open
      });

      app.get('/admin/replayRelevantEvents/:ep/:rm', (req, res) => {
        res.json(['ITEM_CREATED', 'ITEM_UPDATED']);
      });

      app.get('/admin/backup/list/:ep/:rm', (req, res) => {
        res.json([
          {
            backupId: 'backup-001',
            readModelName: req.params.rm,
            timestamp: Date.now(),
          },
        ]);
      });

      mockRmServer = app.listen(0, '127.0.0.1', () => {
        mockRmPort = mockRmServer.address().port;
        console.log(`[ENV admin] Mock RM server on port ${mockRmPort}`);
        resolve();
      });
    });

  // Mock CP HTTP service
  const startMockCpService = () =>
    new Promise((resolve) => {
      const app = expressApp();
      app.use(bodyParser.json());

      app.get('/admin/commandprocessor/status', (req, res) => {
        res.json({
          state: 'idle',
          activeReplays: [],
          activeCatchUps: [],
        });
      });

      app.get('/admin/commandprocessor/events', (req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(':keepalive\n\n');
      });

      mockCpServer = app.listen(0, '127.0.0.1', () => {
        mockCpPort = mockCpServer.address().port;
        console.log(`[ENV admin] Mock CP server on port ${mockCpPort}`);
        resolve();
      });
    });

  const createTestEventBus = () => {
    publishedCommands = [];
    return () =>
      Promise.resolve({
        publishAdminInstruction: vi
          .fn()
          .mockImplementation((correlationId) => (command) => {
            publishedCommands.push({ correlationId, ...command });
          }),
      });
  };

  beforeAll(() =>
    Promise.all([startMockRmService(), startMockCpService()]).then(() =>
      startAdmin(
        { serviceId: 'INTEGRATION-TEST' },
        {
          port: 0,
          eventBus: createTestEventBus(),
          readModelServiceUrl: `http://127.0.0.1:${mockRmPort}`,
          commandProcessorUrl: `http://127.0.0.1:${mockCpPort}`,
        },
      ).then((s) => {
        server = s;
        adminPort = server.address().port;
        console.log(`[ENV admin] Admin server on port ${adminPort}`);
        console.log(`[ENV admin] Admin → RM: http://127.0.0.1:${mockRmPort}`);
        console.log(`[ENV admin] Admin → CP: http://127.0.0.1:${mockCpPort}`);
        // No SSE warm-up wait needed: endpoints that read from the status
        // cache refresh it on demand while no SSE is connected
      }),
    ),
  );

  afterAll(() =>
    Promise.all([
      server
        ? new Promise((resolve) => server.close(resolve))
        : Promise.resolve(),
      mockRmServer
        ? new Promise((resolve) => mockRmServer.close(resolve))
        : Promise.resolve(),
      mockCpServer
        ? new Promise((resolve) => mockCpServer.close(resolve))
        : Promise.resolve(),
    ]),
  );

  const fetchJSON = (path, options = {}) =>
    fetch(`http://127.0.0.1:${adminPort}${path}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    }).then((res) => res.json().then((body) => ({ status: res.status, body })));

  // --- Status endpoints ---

  test('GET /admin/readmodel/status returns all RM statuses', () =>
    fetchJSON('/admin/readmodel/status').then(({ status, body }) => {
      expect(status).toBe(200);
      expect(Array.isArray(body)).toBe(true);
    }));

  test('GET /admin/commandprocessor/status returns CP status', () =>
    fetchJSON('/admin/commandprocessor/status').then(({ status, body }) => {
      expect(status).toBe(200);
      expect(body).toHaveProperty('state');
    }));

  // --- SSE endpoint ---

  test('GET /admin/events returns SSE stream', () => {
    const controller = new AbortController();
    return fetch(`http://127.0.0.1:${adminPort}/admin/events`, {
      signal: controller.signal,
    })
      .then((res) => {
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('text/event-stream');
        controller.abort();
      })
      .catch((err) => {
        if (err.name !== 'AbortError') throw err;
      });
  });

  // --- Replay endpoints ---

  test('POST /admin/replay/start/:ep/:rm returns 202', () =>
    fetchJSON('/admin/replay/start/ep1/customers', {
      method: 'POST',
      body: JSON.stringify({ autoBackup: false }),
    }).then(({ status, body }) => {
      expect(status).toBe(202);
      expect(body.status).toBe('started');
      expect(body.endpointName).toBe('ep1');
      expect(body.readModel).toBe('customers');
    }));

  test('POST /admin/replay/cancel/:ep/:rm returns cancelling', () =>
    fetchJSON('/admin/replay/cancel/ep1/customers', {
      method: 'POST',
      body: '{}',
    }).then(({ status, body }) => {
      expect(status).toBe(200);
      expect(body.status).toBe('cancelling');
    }));

  // --- Backup endpoints ---

  test('POST /admin/backup/create/:ep/:rm publishes command', () => {
    publishedCommands = [];
    return fetchJSON('/admin/backup/create/ep1/customers', {
      method: 'POST',
      body: '{}',
    }).then(({ status, body }) => {
      expect(status).toBe(202);
      expect(body.status).toBe('creating');
      const cmd = publishedCommands.find((c) => c.type === 'createBackup');
      expect(cmd).toBeDefined();
      expect(cmd.targetEndpointName).toBe('ep1');
      expect(cmd.targetReadModel).toBe('customers');
    });
  });

  test('GET /admin/backup/list/:ep/:rm proxies to RM service', () =>
    fetchJSON('/admin/backup/list/ep1/customers').then(({ status, body }) => {
      expect(status).toBe(200);
      expect(Array.isArray(body)).toBe(true);
      expect(body[0].backupId).toBe('backup-001');
    }));

  test('POST /admin/backup/restore/:ep/:rm returns 400 without backupId', () =>
    fetchJSON('/admin/backup/restore/ep1/customers', {
      method: 'POST',
      body: '{}',
    }).then(({ status, body }) => {
      expect(status).toBe(400);
      expect(body.error).toMatch(/backupId/);
    }));

  test('POST /admin/backup/restore/:ep/:rm returns 202 with backupId', () =>
    fetchJSON('/admin/backup/restore/ep1/customers', {
      method: 'POST',
      body: JSON.stringify({ backupId: 'backup-001' }),
    }).then(({ status, body }) => {
      expect(status).toBe(202);
      expect(body.status).toBe('restoring');
    }));

  test('POST /admin/backup/delete/:ep/:rm returns 400 without backupId', () =>
    fetchJSON('/admin/backup/delete/ep1/customers', {
      method: 'POST',
      body: '{}',
    }).then(({ status, body }) => {
      expect(status).toBe(400);
      expect(body.error).toMatch(/backupId/);
    }));

  // --- Lifecycle endpoints ---

  test('POST /admin/readmodel/stop/:ep/:rm publishes stop command', () => {
    publishedCommands = [];
    return fetchJSON('/admin/readmodel/stop/ep1/customers', {
      method: 'POST',
      body: '{}',
    }).then(({ status, body }) => {
      expect(status).toBe(200);
      expect(body.status).toBe('stopping');
      const cmd = publishedCommands.find((c) => c.type === 'stop');
      expect(cmd).toBeDefined();
      expect(cmd.targetEndpointName).toBe('ep1');
      expect(cmd.targetReadModel).toBe('customers');
    });
  });

  test('POST /admin/readmodel/reset/:ep/:rm publishes reset command', () => {
    publishedCommands = [];
    return fetchJSON('/admin/readmodel/reset/ep1/customers', {
      method: 'POST',
      body: '{}',
    }).then(({ status, body }) => {
      expect(status).toBe(200);
      expect(body.status).toBe('resetting');
      const cmd = publishedCommands.find((c) => c.type === 'reset');
      expect(cmd).toBeDefined();
    });
  });

  test('POST /admin/readmodel/activate/:ep/:rm returns 202', () =>
    fetchJSON('/admin/readmodel/activate/ep1/customers', {
      method: 'POST',
      body: '{}',
    }).then(({ status, body }) => {
      expect(status).toBe(202);
      expect(body.status).toBe('activating');
    }));

  test('POST /admin/readmodel/activate-all returns 202', () =>
    fetchJSON('/admin/readmodel/activate-all', {
      method: 'POST',
      body: '{}',
    }).then(({ status, body }) => {
      expect(status).toBe(202);
      expect(body.status).toBe('activating');
    }));
});
