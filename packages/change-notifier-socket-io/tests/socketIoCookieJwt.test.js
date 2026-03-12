import { describe, test, expect, vi, beforeEach } from 'vitest';

const mockVerify = vi.fn();
const mockDecode = vi.fn();
vi.mock('jsonwebtoken', () => ({
  default: { verify: mockVerify, decode: mockDecode },
}));

const mockParse = vi.fn();
vi.mock('cookie', () => ({
  default: { parse: mockParse },
}));

const mockGetSigningKey = vi.fn();
const mockJwksClientConstructor = vi.fn();
vi.mock('jwks-rsa', () => {
  return {
    JwksClient: class MockJwksClient {
      constructor(opts) {
        mockJwksClientConstructor(opts);
        this.getSigningKey = mockGetSigningKey;
      }
    },
  };
});

const { socketIoCookieJwt } = await import('../socketIoCookieJwt.js');

describe('socketIoCookieJwt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('HS256 (sync) path', () => {
    test('extracts token from socket.handshake.auth.token and sets decoded_token', () => {
      mockVerify.mockReturnValue({ sub: 'user-1' });
      const middleware = socketIoCookieJwt({ jwtSecret: 'secret' });
      const socket = {
        handshake: { auth: { token: 'valid-token' }, headers: {} },
      };
      const next = vi.fn();

      middleware(socket, next);

      expect(mockVerify).toHaveBeenCalledWith('valid-token', 'secret', {
        algorithms: ['HS256'],
      });
      expect(socket.decoded_token).toEqual({ sub: 'user-1' });
    });

    test('extracts token from cookie when no auth token present', () => {
      mockVerify.mockReturnValue({ sub: 'user-2' });
      mockParse.mockReturnValue({ access_token: 'cookie-token' });
      const middleware = socketIoCookieJwt({ jwtSecret: 'secret' });
      const socket = {
        handshake: {
          auth: {},
          headers: { cookie: 'access_token=cookie-token' },
        },
      };
      const next = vi.fn();

      middleware(socket, next);

      expect(mockParse).toHaveBeenCalledWith('access_token=cookie-token');
      expect(mockVerify).toHaveBeenCalledWith('cookie-token', 'secret', {
        algorithms: ['HS256'],
      });
      expect(socket.decoded_token).toEqual({ sub: 'user-2' });
    });

    test('leaves decoded_token undefined when no auth token and no cookie', () => {
      const middleware = socketIoCookieJwt({ jwtSecret: 'secret' });
      const socket = {
        handshake: { auth: {}, headers: {} },
      };
      const next = vi.fn();

      middleware(socket, next);

      expect(mockVerify).not.toHaveBeenCalled();
      expect(socket.decoded_token).toBeUndefined();
    });

    test('sets decoded_token to null when jwt.verify throws', () => {
      mockVerify.mockImplementation(() => {
        throw new Error('invalid token');
      });
      const middleware = socketIoCookieJwt({ jwtSecret: 'secret' });
      const socket = {
        handshake: { auth: { token: 'bad-token' }, headers: {} },
      };
      const next = vi.fn();

      middleware(socket, next);

      expect(mockVerify).toHaveBeenCalledWith('bad-token', 'secret', {
        algorithms: ['HS256'],
      });
      expect(socket.decoded_token).toBeNull();
    });

    test('always calls next()', () => {
      const middleware = socketIoCookieJwt({ jwtSecret: 'secret' });
      const socket = {
        handshake: { auth: {}, headers: {} },
      };
      const next = vi.fn();

      middleware(socket, next);

      expect(next).toHaveBeenCalledOnce();
    });

    test('always calls next() even when token is found', () => {
      mockVerify.mockReturnValue({ sub: 'user-1' });
      const middleware = socketIoCookieJwt({ jwtSecret: 'secret' });
      const socket = {
        handshake: { auth: { token: 'valid-token' }, headers: {} },
      };
      const next = vi.fn();

      middleware(socket, next);

      expect(next).toHaveBeenCalledOnce();
    });

    test('uses custom cookieName to extract from cookie', () => {
      mockVerify.mockReturnValue({ sub: 'user-3' });
      mockParse.mockReturnValue({ my_token: 'custom-cookie-token' });
      const middleware = socketIoCookieJwt({
        jwtSecret: 'secret',
        cookieName: 'my_token',
      });
      const socket = {
        handshake: {
          auth: {},
          headers: { cookie: 'my_token=custom-cookie-token' },
        },
      };
      const next = vi.fn();

      middleware(socket, next);

      expect(mockVerify).toHaveBeenCalledWith('custom-cookie-token', 'secret', {
        algorithms: ['HS256'],
      });
      expect(socket.decoded_token).toEqual({ sub: 'user-3' });
    });

    test('does not check cookie when auth token is present', () => {
      mockVerify.mockReturnValue({ sub: 'user-1' });
      const middleware = socketIoCookieJwt({ jwtSecret: 'secret' });
      const socket = {
        handshake: {
          auth: { token: 'auth-token' },
          headers: { cookie: 'access_token=cookie-token' },
        },
      };
      const next = vi.fn();

      middleware(socket, next);

      expect(mockParse).not.toHaveBeenCalled();
      expect(mockVerify).toHaveBeenCalledWith('auth-token', 'secret', {
        algorithms: ['HS256'],
      });
    });
  });

  describe('JWKS (async) path', () => {
    test('creates JwksClient with jwksUri, cache, and rateLimit', () => {
      socketIoCookieJwt({
        jwksUri: 'https://auth.example.com/.well-known/jwks.json',
      });

      expect(mockJwksClientConstructor).toHaveBeenCalledWith({
        jwksUri: 'https://auth.example.com/.well-known/jwks.json',
        cache: true,
        rateLimit: true,
      });
    });

    test('resolves signing key by kid and verifies token', () => {
      mockDecode.mockReturnValue({
        header: { kid: 'key-123', alg: 'RS256' },
        payload: { sub: 'user-jwks' },
      });
      mockGetSigningKey.mockResolvedValue({
        getPublicKey: () => 'rsa-public-key-pem',
      });
      mockVerify.mockReturnValue({ sub: 'user-jwks' });

      const middleware = socketIoCookieJwt({
        jwksUri: 'https://auth.example.com/.well-known/jwks.json',
        jwtAlgorithms: ['RS256'],
      });
      const socket = {
        handshake: { auth: { token: 'rs256-token' }, headers: {} },
      };
      const next = vi.fn();

      return new Promise((resolve) => {
        const originalNext = () => {
          next();
          resolve();
        };
        middleware(socket, originalNext);
      }).then(() => {
        expect(mockDecode).toHaveBeenCalledWith('rs256-token', {
          complete: true,
        });
        expect(mockGetSigningKey).toHaveBeenCalledWith('key-123');
        expect(mockVerify).toHaveBeenCalledWith(
          'rs256-token',
          'rsa-public-key-pem',
          { algorithms: ['RS256'] },
        );
        expect(socket.decoded_token).toEqual({ sub: 'user-jwks' });
        expect(next).toHaveBeenCalledOnce();
      });
    });

    test('sets decoded_token to null when token has no kid', () => {
      mockDecode.mockReturnValue({
        header: { alg: 'RS256' },
        payload: {},
      });

      const middleware = socketIoCookieJwt({
        jwksUri: 'https://auth.example.com/.well-known/jwks.json',
      });
      const socket = {
        handshake: { auth: { token: 'no-kid-token' }, headers: {} },
      };
      const next = vi.fn();

      return new Promise((resolve) => {
        middleware(socket, () => {
          next();
          resolve();
        });
      }).then(() => {
        expect(mockGetSigningKey).not.toHaveBeenCalled();
        expect(socket.decoded_token).toBeNull();
        expect(next).toHaveBeenCalledOnce();
      });
    });

    test('sets decoded_token to null when getSigningKey rejects', () => {
      mockDecode.mockReturnValue({
        header: { kid: 'bad-key', alg: 'RS256' },
        payload: {},
      });
      mockGetSigningKey.mockRejectedValue(new Error('SigningKeyNotFoundError'));

      const middleware = socketIoCookieJwt({
        jwksUri: 'https://auth.example.com/.well-known/jwks.json',
      });
      const socket = {
        handshake: { auth: { token: 'bad-key-token' }, headers: {} },
      };
      const next = vi.fn();

      return new Promise((resolve) => {
        middleware(socket, () => {
          next();
          resolve();
        });
      }).then(() => {
        expect(socket.decoded_token).toBeNull();
        expect(next).toHaveBeenCalledOnce();
      });
    });

    test('calls next() when no token is present', () => {
      const middleware = socketIoCookieJwt({
        jwksUri: 'https://auth.example.com/.well-known/jwks.json',
      });
      const socket = {
        handshake: { auth: {}, headers: {} },
      };
      const next = vi.fn();

      middleware(socket, next);

      expect(next).toHaveBeenCalledOnce();
      expect(socket.decoded_token).toBeUndefined();
    });

    test('extracts token from cookie in JWKS mode', () => {
      mockParse.mockReturnValue({ access_token: 'cookie-rs256-token' });
      mockDecode.mockReturnValue({
        header: { kid: 'key-456', alg: 'RS256' },
        payload: { sub: 'cookie-user' },
      });
      mockGetSigningKey.mockResolvedValue({
        getPublicKey: () => 'rsa-public-key-pem-2',
      });
      mockVerify.mockReturnValue({ sub: 'cookie-user' });

      const middleware = socketIoCookieJwt({
        jwksUri: 'https://auth.example.com/.well-known/jwks.json',
        jwtAlgorithms: ['RS256'],
      });
      const socket = {
        handshake: {
          auth: {},
          headers: { cookie: 'access_token=cookie-rs256-token' },
        },
      };
      const next = vi.fn();

      return new Promise((resolve) => {
        middleware(socket, () => {
          next();
          resolve();
        });
      }).then(() => {
        expect(mockParse).toHaveBeenCalledWith(
          'access_token=cookie-rs256-token',
        );
        expect(mockGetSigningKey).toHaveBeenCalledWith('key-456');
        expect(mockVerify).toHaveBeenCalledWith(
          'cookie-rs256-token',
          'rsa-public-key-pem-2',
          { algorithms: ['RS256'] },
        );
        expect(socket.decoded_token).toEqual({ sub: 'cookie-user' });
      });
    });

    test('sets decoded_token to null when jwt.verify throws in JWKS mode', () => {
      mockDecode.mockReturnValue({
        header: { kid: 'key-789', alg: 'RS256' },
        payload: {},
      });
      mockGetSigningKey.mockResolvedValue({
        getPublicKey: () => 'rsa-public-key-pem-3',
      });
      mockVerify.mockImplementation(() => {
        throw new Error('token expired');
      });

      const middleware = socketIoCookieJwt({
        jwksUri: 'https://auth.example.com/.well-known/jwks.json',
        jwtAlgorithms: ['RS256'],
      });
      const socket = {
        handshake: { auth: { token: 'expired-token' }, headers: {} },
      };
      const next = vi.fn();

      return new Promise((resolve) => {
        middleware(socket, () => {
          next();
          resolve();
        });
      }).then(() => {
        expect(socket.decoded_token).toBeNull();
        expect(next).toHaveBeenCalledOnce();
      });
    });
  });
});
