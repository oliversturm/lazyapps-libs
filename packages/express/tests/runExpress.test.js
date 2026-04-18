import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @lazyapps/logger so runExpress doesn't try to spin up the real
// logger pipeline. Provide both getLogger and getStream.
vi.mock('@lazyapps/logger', () => {
  const debugBare = vi.fn();
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debugBare,
  };
  const getLogger = vi.fn().mockReturnValue(log);
  const getStream = () => ({
    write: () => {},
  });
  return { getLogger, getStream, safeStringify: (o) => JSON.stringify(o) };
});

const { runExpress } = await import('../runExpress.js');

const noopLog = {
  debug: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debugBare: vi.fn(),
};

// Spin up a server on an ephemeral port. Returns {server, baseUrl, close}.
const startServer = (opts = {}) => {
  const installHandlers =
    opts.installHandlers ||
    ((_ctx, app) => {
      app.post('/echo', (req, res) => {
        res.status(200).json({ ok: true, body: req.body });
      });
      app.get('/ping', (_req, res) => {
        res.status(200).send('pong');
      });
    });

  return runExpress({
    log: noopLog,
    port: 0, // ephemeral
    interfaceIp: '127.0.0.1',
    installHandlers,
    ...opts.runExpressOverrides,
  })({ correlationConfig: { serviceId: 'TEST' } }).then((server) => {
    const addr = server.address();
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    const close = () => new Promise((resolve) => server.close(() => resolve()));
    return { server, baseUrl, close };
  });
};

describe('runExpress hardening parameters (SEC-T2-A1/A2/A4/A5)', () => {
  let handle;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (handle) {
      const c = handle.close();
      handle = null;
      return c;
    }
  });

  // ----- A1: corsOrigin ---------------------------------------------------

  describe('A1 — corsOrigin parameter', () => {
    test('default (unset) responds with wildcard Access-Control-Allow-Origin', () => {
      return startServer().then((h) => {
        handle = h;
        return fetch(`${h.baseUrl}/ping`, {
          method: 'GET',
          headers: { Origin: 'https://example.com' },
        }).then((res) => {
          // DA: explicit assertion that the documented default IS wildcard.
          expect(res.headers.get('access-control-allow-origin')).toBe('*');
        });
      });
    });

    test('when set to a specific origin, response reflects that origin', () => {
      return startServer({
        runExpressOverrides: { corsOrigin: 'https://allowed.example' },
      }).then((h) => {
        handle = h;
        return fetch(`${h.baseUrl}/ping`, {
          method: 'GET',
          headers: { Origin: 'https://allowed.example' },
        }).then((res) => {
          expect(res.headers.get('access-control-allow-origin')).toBe(
            'https://allowed.example',
          );
        });
      });
    });

    test('when set to an array of origins, only listed origins are reflected', () => {
      return startServer({
        runExpressOverrides: {
          corsOrigin: ['https://a.example', 'https://b.example'],
        },
      }).then((h) => {
        handle = h;
        return fetch(`${h.baseUrl}/ping`, {
          method: 'GET',
          headers: { Origin: 'https://a.example' },
        })
          .then((res) => {
            expect(res.headers.get('access-control-allow-origin')).toBe(
              'https://a.example',
            );
          })
          .then(() =>
            fetch(`${h.baseUrl}/ping`, {
              method: 'GET',
              headers: { Origin: 'https://evil.example' },
            }),
          )
          .then((res) => {
            // Either no header or not the evil origin — must NOT be reflected.
            const acao = res.headers.get('access-control-allow-origin');
            expect(acao === null || acao !== 'https://evil.example').toBe(true);
          });
      });
    });
  });

  // ----- A2: bodyLimit ----------------------------------------------------

  describe('A2 — bodyLimit parameter', () => {
    test('default (~100kb) accepts ~50KB body', () => {
      return startServer().then((h) => {
        handle = h;
        const body = JSON.stringify({ data: 'x'.repeat(50 * 1024) });
        return fetch(`${h.baseUrl}/echo`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        }).then((res) => {
          expect(res.status).toBe(200);
        });
      });
    });

    test('default (~100kb) rejects ~200KB body with 413', () => {
      return startServer().then((h) => {
        handle = h;
        const body = JSON.stringify({ data: 'x'.repeat(200 * 1024) });
        return fetch(`${h.baseUrl}/echo`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        }).then((res) => {
          expect(res.status).toBe(413);
        });
      });
    });

    test('explicit bodyLimit "1kb" rejects a 5KB body with 413', () => {
      return startServer({
        runExpressOverrides: { bodyLimit: '1kb' },
      }).then((h) => {
        handle = h;
        const body = JSON.stringify({ data: 'x'.repeat(5 * 1024) });
        return fetch(`${h.baseUrl}/echo`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        }).then((res) => {
          expect(res.status).toBe(413);
        });
      });
    });

    test('explicit bodyLimit "10mb" accepts a 200KB body', () => {
      return startServer({
        runExpressOverrides: { bodyLimit: '10mb' },
      }).then((h) => {
        handle = h;
        const body = JSON.stringify({ data: 'x'.repeat(200 * 1024) });
        return fetch(`${h.baseUrl}/echo`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        }).then((res) => {
          expect(res.status).toBe(200);
        });
      });
    });
  });

  // ----- A4: helmet -------------------------------------------------------

  describe('A4 — helmet parameter', () => {
    test('when helmet:true, response includes helmet default security headers', () => {
      return startServer({
        runExpressOverrides: { helmet: true },
      }).then((h) => {
        handle = h;
        return fetch(`${h.baseUrl}/ping`).then((res) => {
          // Helmet default header set (a representative subset).
          expect(res.headers.get('x-content-type-options')).toBe('nosniff');
          expect(res.headers.get('x-dns-prefetch-control')).toBeTruthy();
          // Helmet sets X-Frame-Options to SAMEORIGIN by default.
          expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
        });
      });
    });

    test('when helmet not set, helmet-specific headers are absent', () => {
      return startServer().then((h) => {
        handle = h;
        return fetch(`${h.baseUrl}/ping`).then((res) => {
          expect(res.headers.get('x-content-type-options')).toBeNull();
          expect(res.headers.get('x-dns-prefetch-control')).toBeNull();
        });
      });
    });

    test('when helmet:false, helmet-specific headers are absent', () => {
      return startServer({
        runExpressOverrides: { helmet: false },
      }).then((h) => {
        handle = h;
        return fetch(`${h.baseUrl}/ping`).then((res) => {
          expect(res.headers.get('x-content-type-options')).toBeNull();
          expect(res.headers.get('x-dns-prefetch-control')).toBeNull();
        });
      });
    });

    test('when helmet is an object, it is passed as helmet options', () => {
      // Disable contentSecurityPolicy via options — verify the override took
      // effect by checking that the CSP header is NOT set while a different
      // helmet header IS set (proving helmet ran with custom options).
      return startServer({
        runExpressOverrides: {
          helmet: { contentSecurityPolicy: false },
        },
      }).then((h) => {
        handle = h;
        return fetch(`${h.baseUrl}/ping`).then((res) => {
          expect(res.headers.get('x-content-type-options')).toBe('nosniff');
          expect(res.headers.get('content-security-policy')).toBeNull();
        });
      });
    });
  });

  // ----- A5: rateLimiter --------------------------------------------------

  describe('A5 — rateLimiter parameter', () => {
    test('when rateLimiter middleware is provided, it is invoked per request', () => {
      const rateLimiter = vi.fn((_req, _res, next) => next());
      return startServer({
        runExpressOverrides: { rateLimiter },
      }).then((h) => {
        handle = h;
        return fetch(`${h.baseUrl}/ping`).then(() => {
          expect(rateLimiter).toHaveBeenCalled();
        });
      });
    });

    test('when rateLimiter not provided, no-op (request still served)', () => {
      return startServer().then((h) => {
        handle = h;
        return fetch(`${h.baseUrl}/ping`).then((res) => {
          expect(res.status).toBe(200);
        });
      });
    });

    test('rateLimiter that rejects (429) blocks request before route runs', () => {
      let routeCalled = false;
      const rateLimiter = (_req, res, _next) => {
        res.status(429).send('Too Many Requests');
      };
      const installHandlers = (_ctx, app) => {
        app.get('/ping', (_req, res) => {
          routeCalled = true;
          res.status(200).send('pong');
        });
      };
      return startServer({
        installHandlers,
        runExpressOverrides: { rateLimiter },
      }).then((h) => {
        handle = h;
        return fetch(`${h.baseUrl}/ping`).then((res) => {
          expect(res.status).toBe(429);
          expect(routeCalled).toBe(false);
        });
      });
    });
  });

  // ----- Ordering: helmet → rateLimiter → bodyParser → cors → routes -----

  describe('middleware ordering', () => {
    test('helmet runs before bodyParser (413 response still has helmet headers)', () => {
      return startServer({
        runExpressOverrides: { helmet: true, bodyLimit: '1kb' },
      }).then((h) => {
        handle = h;
        const body = JSON.stringify({ data: 'x'.repeat(5 * 1024) });
        return fetch(`${h.baseUrl}/echo`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        }).then((res) => {
          expect(res.status).toBe(413);
          // If helmet ran AFTER bodyParser, bodyParser's 413 (served by
          // Express's finalhandler) would not carry helmet-only headers.
          // Use x-frame-options (a helmet-only default) — finalhandler sets
          // x-content-type-options:nosniff on its own, so we cannot rely on
          // that to prove ordering.
          expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
        });
      });
    });

    test('rateLimiter runs before bodyParser (large body is rate-limited, not parsed first)', () => {
      const calls = [];
      const rateLimiter = (_req, _res, next) => {
        calls.push('rateLimiter');
        next();
      };
      const installHandlers = (_ctx, app) => {
        app.post('/echo', (_req, res) => {
          calls.push('route');
          res.status(200).send('ok');
        });
      };
      return startServer({
        installHandlers,
        runExpressOverrides: {
          rateLimiter,
          bodyLimit: '1kb',
        },
      }).then((h) => {
        handle = h;
        const body = JSON.stringify({ data: 'x'.repeat(5 * 1024) });
        return fetch(`${h.baseUrl}/echo`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        }).then((res) => {
          expect(res.status).toBe(413);
          // rateLimiter must have been called before bodyParser rejected the
          // oversize body — proves correct ordering.
          expect(calls).toContain('rateLimiter');
          expect(calls).not.toContain('route');
        });
      });
    });
  });
});
