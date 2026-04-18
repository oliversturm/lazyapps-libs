import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@lazyapps/logger', () => {
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debugBare: vi.fn(),
  };
  const getLogger = vi.fn().mockReturnValue(log);
  const getStream = () => ({ write: () => {} });
  return { getLogger, getStream, safeStringify: (o) => JSON.stringify(o) };
});

const { runExpress } = await import('../express.js');

const startServer = (opts = {}) =>
  runExpress(
    { serviceId: 'TEST' },
    {
      port: 0,
      host: '127.0.0.1',
      ...opts,
    },
  ).then((server) => {
    const addr = server.address();
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    const close = () => new Promise((resolve) => server.close(() => resolve()));
    return { server, baseUrl, close };
  });

describe('change-notifier-socket-io express hardening (SEC-T2-A1/A2/A4/A5)', () => {
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

  // A1 corsOrigin --------------------------------------------------------

  test('A1: default Access-Control-Allow-Origin is wildcard', () => {
    return startServer().then((h) => {
      handle = h;
      // Hit a non-existent path — cors middleware runs before routing so
      // its headers are present on the 404 response too.
      return fetch(`${h.baseUrl}/__no_such_route__`, {
        method: 'GET',
        headers: { Origin: 'https://example.com' },
      }).then((res) => {
        expect(res.headers.get('access-control-allow-origin')).toBe('*');
      });
    });
  });

  test('A1: corsOrigin reflects specific origin when set', () => {
    return startServer({ corsOrigin: 'https://allowed.example' }).then((h) => {
      handle = h;
      return fetch(`${h.baseUrl}/__no_such_route__`, {
        method: 'GET',
        headers: { Origin: 'https://allowed.example' },
      }).then((res) => {
        expect(res.headers.get('access-control-allow-origin')).toBe(
          'https://allowed.example',
        );
      });
    });
  });

  // A2 bodyLimit ---------------------------------------------------------

  test('A2: bodyLimit "1kb" rejects 5KB POST with 413', () => {
    return startServer({ bodyLimit: '1kb' }).then((h) => {
      handle = h;
      const body = JSON.stringify({ data: 'x'.repeat(5 * 1024) });
      return fetch(`${h.baseUrl}/change`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }).then((res) => {
        expect(res.status).toBe(413);
      });
    });
  });

  // A4 helmet ------------------------------------------------------------

  // POST a minimal valid body to /change so the response comes from the
  // notifier handler (200) rather than Express's default 404 finalhandler,
  // which on its own sets `X-Content-Type-Options: nosniff` and would
  // produce a false positive for the helmet assertion.
  const validChangeBody = () =>
    JSON.stringify({
      correlationId: 'corr-test',
      endpointName: 'test',
      readModelName: 'test',
      resolverName: 'test',
    });

  test('A4: helmet:true sets default security headers on responses', () => {
    return startServer({ helmet: true }).then((h) => {
      handle = h;
      return fetch(`${h.baseUrl}/change`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: validChangeBody(),
      }).then((res) => {
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
      });
    });
  });

  test('A4: helmet not set → no helmet-specific headers on 200 response', () => {
    return startServer().then((h) => {
      handle = h;
      return fetch(`${h.baseUrl}/change`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: validChangeBody(),
      }).then((res) => {
        // 200 from notifier — Express finalhandler is NOT involved here so
        // x-content-type-options stays unset unless helmet wired it.
        expect(res.headers.get('x-content-type-options')).toBeNull();
      });
    });
  });

  // A5 rateLimiter -------------------------------------------------------

  test('A5: rateLimiter middleware is invoked when supplied', () => {
    const rateLimiter = vi.fn((_req, _res, next) => next());
    return startServer({ rateLimiter }).then((h) => {
      handle = h;
      return fetch(`${h.baseUrl}/__no_such_route__`).then(() => {
        expect(rateLimiter).toHaveBeenCalled();
      });
    });
  });

  // Ordering -------------------------------------------------------------

  test('helmet runs before bodyParser (413 response still has helmet headers)', () => {
    return startServer({ helmet: true, bodyLimit: '1kb' }).then((h) => {
      handle = h;
      const body = JSON.stringify({ data: 'x'.repeat(5 * 1024) });
      return fetch(`${h.baseUrl}/change`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }).then((res) => {
        expect(res.status).toBe(413);
        // Use x-frame-options — a helmet-only header. Express finalhandler
        // sets x-content-type-options on its own so it cannot prove ordering.
        expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
      });
    });
  });
});
