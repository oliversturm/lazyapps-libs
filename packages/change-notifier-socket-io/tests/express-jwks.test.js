import { describe, test, expect, vi, beforeEach } from 'vitest';

// Track calls to expressjwt to inspect the secret/algorithms used
const mockExpressjwt = vi.fn(() => (req, res, next) => next());
const mockExpressJwtSecret = vi.fn(() => 'jwks-constructed-secret');

vi.mock('express-jwt', () => ({
  expressjwt: mockExpressjwt,
}));

vi.mock('jwks-rsa', () => ({
  expressJwtSecret: mockExpressJwtSecret,
}));

// Mock all other heavy dependencies so runExpress doesn't start a real server
const mockListen = vi.fn(() => {});
const mockOn = vi.fn((event, cb) => {
  if (event === 'listening') cb();
});
const mockServer = { listen: mockListen, on: mockOn };
vi.mock('http', () => ({
  default: {
    createServer: vi.fn(() => mockServer),
  },
}));

const mockApp = {
  use: vi.fn(),
  post: vi.fn(),
};
vi.mock('express', () => ({
  default: vi.fn(() => mockApp),
}));

vi.mock('body-parser', () => ({
  default: { json: vi.fn(() => 'body-parser-json') },
}));

vi.mock('morgan', () => {
  const m = vi.fn(() => 'morgan-middleware');
  m.token = vi.fn();
  return { default: m };
});

vi.mock('cors', () => ({
  default: vi.fn(() => 'cors-middleware'),
}));

vi.mock('cookie-parser', () => ({
  default: vi.fn(() => 'cookie-parser-middleware'),
}));

vi.mock('socket.io', () => ({
  Server: vi.fn(() => ({
    use: vi.fn(),
  })),
}));

vi.mock('../socketIoCookieJwt.js', () => ({
  socketIoCookieJwt: vi.fn(() => 'socket-jwt-middleware'),
}));

vi.mock('../notifier.js', () => ({
  initSockets: vi.fn(),
  createNotifier: vi.fn(() => 'notifier-handler'),
}));

vi.mock('../redaction.js', () => ({
  createRedactionEngine: vi.fn(() => ({ redact: vi.fn() })),
}));

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn(() => ({
    debug: vi.fn(),
    debugBare: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  })),
  getStream: vi.fn(() => process.stdout),
}));

const { runExpress } = await import('../express.js');

describe('JWKS URI propagation in runExpress', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOn.mockImplementation((event, cb) => {
      if (event === 'listening') cb();
    });
  });

  test('auto-constructs jwtAuth from jwksUri when jwtAuth is not provided', () =>
    runExpress(
      {},
      { jwksUri: 'https://auth.example.com/.well-known/jwks.json' },
    ).then(() => {
      expect(mockExpressJwtSecret).toHaveBeenCalledWith({
        cache: true,
        rateLimit: true,
        jwksRequestsPerMinute: 5,
        jwksUri: 'https://auth.example.com/.well-known/jwks.json',
      });

      // expressjwt should have been called with the constructed secret
      expect(mockExpressjwt).toHaveBeenCalledWith(
        expect.objectContaining({
          secret: 'jwks-constructed-secret',
          algorithms: ['RS256'],
        }),
      );
    }));

  test('uses explicit jwtAuth when both jwtAuth and jwksUri are provided', () =>
    runExpress(
      {},
      {
        jwtAuth: 'my-explicit-secret',
        jwksUri: 'https://auth.example.com/.well-known/jwks.json',
      },
    ).then(() => {
      // expressJwtSecret should NOT have been called
      expect(mockExpressJwtSecret).not.toHaveBeenCalled();

      // expressjwt should use the explicit secret
      expect(mockExpressjwt).toHaveBeenCalledWith(
        expect.objectContaining({
          secret: 'my-explicit-secret',
          algorithms: ['HS256'],
        }),
      );
    }));

  test('does not set up JWT middleware when neither jwtAuth nor jwksUri is provided', () =>
    runExpress({}, { port: 3008 }).then(() => {
      expect(mockExpressJwtSecret).not.toHaveBeenCalled();
      expect(mockExpressjwt).not.toHaveBeenCalled();
    }));

  test('uses custom jwtAlgorithms with jwksUri when explicitly provided', () =>
    runExpress(
      {},
      {
        jwksUri: 'https://auth.example.com/.well-known/jwks.json',
        jwtAlgorithms: ['RS384', 'RS512'],
      },
    ).then(() => {
      expect(mockExpressjwt).toHaveBeenCalledWith(
        expect.objectContaining({
          secret: 'jwks-constructed-secret',
          algorithms: ['RS384', 'RS512'],
        }),
      );
    }));

  test('backwards compat: existing jwtSecret alias still works', () =>
    runExpress({}, { jwtSecret: 'legacy-secret' }).then(() => {
      expect(mockExpressJwtSecret).not.toHaveBeenCalled();
      expect(mockExpressjwt).toHaveBeenCalledWith(
        expect.objectContaining({
          secret: 'legacy-secret',
          algorithms: ['HS256'],
        }),
      );
    }));
});
