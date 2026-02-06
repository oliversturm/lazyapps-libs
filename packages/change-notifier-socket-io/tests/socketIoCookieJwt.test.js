import { describe, test, expect, vi, beforeEach } from 'vitest';

const mockVerify = vi.fn();
vi.mock('jsonwebtoken', () => ({
  default: { verify: mockVerify },
}));

const mockParse = vi.fn();
vi.mock('cookie', () => ({
  default: { parse: mockParse },
}));

const { socketIoCookieJwt } = await import('../socketIoCookieJwt.js');

describe('socketIoCookieJwt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('extracts token from socket.handshake.auth.token and sets decoded_token', () => {
    mockVerify.mockReturnValue({ sub: 'user-1' });
    const middleware = socketIoCookieJwt({ jwtSecret: 'secret' });
    const socket = {
      handshake: { auth: { token: 'valid-token' }, headers: {} },
    };
    const next = vi.fn();

    middleware(socket, next);

    expect(mockVerify).toHaveBeenCalledWith('valid-token', 'secret');
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
    expect(mockVerify).toHaveBeenCalledWith('cookie-token', 'secret');
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

    expect(mockVerify).toHaveBeenCalledWith('bad-token', 'secret');
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

    expect(mockVerify).toHaveBeenCalledWith('custom-cookie-token', 'secret');
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
    expect(mockVerify).toHaveBeenCalledWith('auth-token', 'secret');
  });
});
