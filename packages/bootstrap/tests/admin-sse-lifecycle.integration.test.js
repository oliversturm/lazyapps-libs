import { describe, test, expect, vi, beforeAll, afterAll } from 'vitest';
import expressApp from 'express';
import bodyParser from 'body-parser';
import { waitForCondition } from './helpers/waitForCondition.js';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { startAdmin } = await import('../admin.js');

// Grace period used by all tests in this file. Short so teardown can be
// observed quickly, long enough not to race the assertions themselves.
const GRACE_MS = 200;

// Builds a mock RM service that counts open SSE connections and lets the
// test push status-change events to connected clients.
const startMockRmService = () =>
  new Promise((resolve) => {
    const state = {
      server: null,
      port: null,
      sseCount: 0,
      sseClients: new Set(),
      stateVersion: 1,
      // Current status per RM, mirroring the real RM statusTracker
      rmStatus: {
        customers: {
          endpointName: 'ep1',
          readModelName: 'customers',
          state: 'idle',
          stateVersion: 1,
          lastProjectedEventTimestamp: 1000,
        },
      },
    };
    const app = expressApp();
    app.use(bodyParser.json());

    app.get('/admin/readmodel', (req, res) => {
      res.json(
        Object.values(state.rmStatus).map((s) => ({
          name: s.readModelName,
          endpointName: s.endpointName,
          state: s.state,
          stateVersion: s.stateVersion,
          lastProjectedEventTimestamp: s.lastProjectedEventTimestamp,
        })),
      );
    });

    const formatStatusEvent = (s) =>
      `event: status-change\ndata: ${JSON.stringify(s)}\n\n`;

    app.get('/admin/events/:ep', (req, res) => {
      state.sseCount++;
      state.sseClients.add(res);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(':keepalive\n\n');
      // The real RM statusTracker sends a snapshot of all RM statuses to
      // every newly connected client — mirror that
      Object.values(state.rmStatus).forEach((s) => {
        res.write(formatStatusEvent(s));
      });
      req.on('close', () => {
        state.sseCount--;
        state.sseClients.delete(res);
      });
    });

    app.get('/admin/replayRelevantEvents/:ep/:rm', (req, res) => {
      res.json(['ITEM_CREATED']);
    });

    state.pushStatus = (rm, rmState) => {
      state.stateVersion++;
      state.rmStatus[rm] = {
        endpointName: 'ep1',
        readModelName: rm,
        state: rmState,
        stateVersion: state.stateVersion,
        lastProjectedEventTimestamp: 1000,
      };
      state.sseClients.forEach((res) => {
        res.write(formatStatusEvent(state.rmStatus[rm]));
      });
    };

    state.server = app.listen(0, '127.0.0.1', () => {
      state.port = state.server.address().port;
      console.log(`[ENV sse-lifecycle] Mock RM server on port ${state.port}`);
      resolve(state);
    });
  });

// Builds a mock CP service that counts open SSE connections.
const startMockCpService = () =>
  new Promise((resolve) => {
    const state = { server: null, port: null, sseCount: 0 };
    const app = expressApp();
    app.use(bodyParser.json());

    app.get('/admin/commandprocessor/status', (req, res) => {
      res.json({ state: 'idle', activeReplays: [], activeCatchUps: [] });
    });

    app.get('/admin/commandprocessor/events', (req, res) => {
      state.sseCount++;
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(':keepalive\n\n');
      req.on('close', () => {
        state.sseCount--;
      });
    });

    state.server = app.listen(0, '127.0.0.1', () => {
      state.port = state.server.address().port;
      console.log(`[ENV sse-lifecycle] Mock CP server on port ${state.port}`);
      resolve(state);
    });
  });

// Drives RM state transitions in response to admin instructions, the way a
// real RM + CP would: activate → catchup, catchupDone → live.
const startActivationDriver = (publishedCommands, rmService) => {
  const handled = new Set();
  const interval = setInterval(() => {
    publishedCommands.forEach((cmd, idx) => {
      if (handled.has(idx)) return;
      if (cmd.type === 'activate') {
        handled.add(idx);
        rmService.pushStatus(cmd.targetReadModel, 'catchup');
      }
      if (cmd.type === 'catchupDone') {
        handled.add(idx);
        rmService.pushStatus(cmd.targetReadModel, 'live');
      }
    });
  }, 25);
  return { stop: () => clearInterval(interval) };
};

const closeServer = (server) =>
  server ? new Promise((resolve) => server.close(resolve)) : Promise.resolve();

describe('admin SSE on-demand lifecycle', { timeout: 30000 }, () => {
  let rmService;
  let cpService;
  let adminServer;
  let adminPort;
  let publishedCommands;

  const upstreamConnections = () =>
    `rm=${rmService.sseCount} cp=${cpService.sseCount}`;

  const noUpstreamConnections = () =>
    rmService.sseCount === 0 && cpService.sseCount === 0
      ? true
      : upstreamConnections();

  const allUpstreamConnected = () =>
    rmService.sseCount === 1 && cpService.sseCount === 1
      ? true
      : upstreamConnections();

  beforeAll(() =>
    Promise.all([startMockRmService(), startMockCpService()]).then(
      ([rm, cp]) => {
        rmService = rm;
        cpService = cp;
        publishedCommands = [];
        return startAdmin(
          { serviceId: 'SSE-LIFECYCLE-TEST' },
          {
            port: 0,
            eventBus: () =>
              Promise.resolve({
                publishAdminInstruction: (correlationId) => (command) => {
                  publishedCommands.push({ correlationId, ...command });
                },
              }),
            readModelServiceUrl: { ep1: `http://127.0.0.1:${rmService.port}` },
            commandProcessorUrl: `http://127.0.0.1:${cpService.port}`,
            sseIdleGraceMs: GRACE_MS,
          },
        ).then((s) => {
          adminServer = s;
          adminPort = s.address().port;
          console.log(`[ENV sse-lifecycle] Admin server on port ${adminPort}`);
        });
      },
    ),
  );

  afterAll(() =>
    Promise.all([
      closeServer(adminServer),
      closeServer(rmService?.server),
      closeServer(cpService?.server),
    ]),
  );

  test('does not open upstream SSE connections while idle', () =>
    // Give any (incorrect) eager connect a chance to happen first
    new Promise((resolve) => setTimeout(resolve, 2 * GRACE_MS)).then(() => {
      expect(adminServer.__testing__.sseClient.isConnected()).toBe(false);
      expect(rmService.sseCount).toBe(0);
      expect(cpService.sseCount).toBe(0);
    }));

  test('serves fresh status over HTTP while no SSE is connected', () =>
    fetch(`http://127.0.0.1:${adminPort}/admin/readmodel/status`)
      .then((res) => {
        expect(res.status).toBe(200);
        return res.json();
      })
      .then((body) => {
        expect(Array.isArray(body)).toBe(true);
        expect(body.some((rm) => rm.readModelName === 'customers')).toBe(true);
        // A plain status read must not bring up SSE subscriptions
        return waitForCondition(
          noUpstreamConnections,
          2000,
          50,
          'no upstream SSE after status read',
        );
      }));

  test('browser connect brings SSE up, last disconnect tears down after grace', () => {
    const controller = new AbortController();
    return fetch(`http://127.0.0.1:${adminPort}/admin/events`, {
      signal: controller.signal,
    })
      .then((res) => {
        expect(res.status).toBe(200);
        return waitForCondition(
          allUpstreamConnected,
          5000,
          50,
          'upstream SSE up after browser connect',
        );
      })
      .then(() => {
        expect(adminServer.__testing__.sseClient.isConnected()).toBe(true);
        controller.abort();
        return waitForCondition(
          noUpstreamConnections,
          5000,
          50,
          'upstream SSE down after browser disconnect',
        );
      })
      .then(() => {
        expect(adminServer.__testing__.sseClient.isConnected()).toBe(false);
      });
  });

  test('admin operation brings SSE up and tears down after completion', () => {
    const commandCountBefore = publishedCommands.length;
    const driver = startActivationDriver(publishedCommands, rmService);

    return fetch(
      `http://127.0.0.1:${adminPort}/admin/readmodel/activate/ep1/customers`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      },
    )
      .then((res) => {
        expect(res.status).toBe(202);
        // Operation connects upstream SSE
        return waitForCondition(
          allUpstreamConnected,
          5000,
          50,
          'upstream SSE up during operation',
        );
      })
      .then(() =>
        // Activation runs to completion (catchupDone published)
        waitForCondition(
          () =>
            publishedCommands
              .slice(commandCountBefore)
              .some((c) => c.type === 'catchupDone')
              ? true
              : `commands=${publishedCommands
                  .slice(commandCountBefore)
                  .map((c) => c.type)
                  .join(',')}`,
          5000,
          50,
          'activation completes',
        ),
      )
      .then(() =>
        // After the operation ends, connections are torn down post-grace
        waitForCondition(
          noUpstreamConnections,
          5000,
          50,
          'upstream SSE down after operation',
        ),
      )
      .then(() => {
        expect(adminServer.__testing__.sseClient.isConnected()).toBe(false);
        const opCommands = publishedCommands
          .slice(commandCountBefore)
          .map((c) => c.type);
        expect(opCommands).toContain('activate');
        expect(opCommands).toContain('startCatchup');
        expect(opCommands).toContain('catchupDone');
      })
      .finally(() => driver.stop());
  });
});

describe('admin SSE lifecycle with auto-activation', { timeout: 30000 }, () => {
  let rmService;
  let cpService;
  let adminServer;
  let publishedCommands;
  let driver;

  beforeAll(() =>
    Promise.all([startMockRmService(), startMockCpService()]).then(
      ([rm, cp]) => {
        rmService = rm;
        cpService = cp;
        publishedCommands = [];
        driver = startActivationDriver(publishedCommands, rmService);
        return startAdmin(
          { serviceId: 'SSE-AUTOACTIVATE-TEST' },
          {
            port: 0,
            eventBus: () =>
              Promise.resolve({
                publishAdminInstruction: (correlationId) => (command) => {
                  publishedCommands.push({ correlationId, ...command });
                },
              }),
            readModelServiceUrl: { ep1: `http://127.0.0.1:${rmService.port}` },
            commandProcessorUrl: `http://127.0.0.1:${cpService.port}`,
            autoActivate: true,
            sseIdleGraceMs: GRACE_MS,
          },
        ).then((s) => {
          adminServer = s;
        });
      },
    ),
  );

  afterAll(() => {
    driver.stop();
    return Promise.all([
      closeServer(adminServer),
      closeServer(rmService?.server),
      closeServer(cpService?.server),
    ]);
  });

  test('auto-activation runs as an operation and goes quiet afterwards', () =>
    // Activation completes (catchupDone published for the discovered RM)
    waitForCondition(
      () =>
        publishedCommands.some(
          (c) => c.type === 'catchupDone' && c.targetReadModel === 'customers',
        )
          ? true
          : `commands=${publishedCommands.map((c) => c.type).join(',')}`,
      10000,
      50,
      'auto-activation completes',
    )
      .then(() =>
        // Connections are torn down after the activation operation ends
        waitForCondition(
          () =>
            rmService.sseCount === 0 && cpService.sseCount === 0
              ? true
              : `rm=${rmService.sseCount} cp=${cpService.sseCount}`,
          5000,
          50,
          'upstream SSE down after auto-activation',
        ),
      )
      .then(() => {
        expect(adminServer.__testing__.sseClient.isConnected()).toBe(false);
        expect(publishedCommands.some((c) => c.type === 'activate')).toBe(true);
      }));
});

describe('admin SSE browser heartbeat', { timeout: 30000 }, () => {
  let rmService;
  let cpService;
  let adminServer;
  let adminPort;

  // Fast heartbeat so its emission is observable within the test window,
  // without racing the assertions.
  const HEARTBEAT_MS = 100;

  beforeAll(() =>
    Promise.all([startMockRmService(), startMockCpService()]).then(
      ([rm, cp]) => {
        rmService = rm;
        cpService = cp;
        return startAdmin(
          { serviceId: 'SSE-HEARTBEAT-TEST' },
          {
            port: 0,
            eventBus: () =>
              Promise.resolve({
                publishAdminInstruction: () => () => {},
              }),
            readModelServiceUrl: { ep1: `http://127.0.0.1:${rmService.port}` },
            commandProcessorUrl: `http://127.0.0.1:${cpService.port}`,
            sseIdleGraceMs: GRACE_MS,
            sseHeartbeatMs: HEARTBEAT_MS,
          },
        ).then((s) => {
          adminServer = s;
          adminPort = s.address().port;
          console.log(`[ENV sse-heartbeat] Admin server on port ${adminPort}`);
        });
      },
    ),
  );

  afterAll(() =>
    Promise.all([
      closeServer(adminServer),
      closeServer(rmService?.server),
      closeServer(cpService?.server),
    ]),
  );

  // Reads the SSE response body until `:heartbeat` appears or the deadline
  // passes. Resolves on success, rejects otherwise.
  const readUntilHeartbeat = (res, deadline) => {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const step = () =>
      reader.read().then(({ done, value }) => {
        if (done) throw new Error('stream ended before a heartbeat arrived');
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes(':heartbeat')) {
          reader.cancel().catch(() => {});
          return;
        }
        if (Date.now() > deadline) {
          reader.cancel().catch(() => {});
          throw new Error('no heartbeat within the deadline');
        }
        return step();
      });
    return step();
  };

  test('emits periodic heartbeat comments to a connected browser client', () => {
    const controller = new AbortController();
    return fetch(`http://127.0.0.1:${adminPort}/admin/events`, {
      signal: controller.signal,
    })
      .then((res) => {
        expect(res.status).toBe(200);
        return readUntilHeartbeat(res, Date.now() + 3000);
      })
      .finally(() => controller.abort());
  });

  test('heartbeats do not prevent idle teardown after the browser disconnects', () => {
    const controller = new AbortController();
    return fetch(`http://127.0.0.1:${adminPort}/admin/events`, {
      signal: controller.signal,
    })
      .then((res) => {
        expect(res.status).toBe(200);
        return readUntilHeartbeat(res, Date.now() + 3000);
      })
      .then(() => {
        expect(adminServer.__testing__.sseClient.isConnected()).toBe(true);
        controller.abort();
        return waitForCondition(
          () =>
            rmService.sseCount === 0 && cpService.sseCount === 0
              ? true
              : `rm=${rmService.sseCount} cp=${cpService.sseCount}`,
          5000,
          50,
          'upstream SSE down after heartbeating browser disconnects',
        );
      })
      .then(() => {
        expect(adminServer.__testing__.sseClient.isConnected()).toBe(false);
      });
  });
});
