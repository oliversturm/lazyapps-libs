import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@lazyapps/logger', () => {
  const getLogger = vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debugBare: vi.fn(),
  });
  return { getLogger, getStream: vi.fn() };
});

const mockNanoid = vi.fn().mockReturnValue('generated-id');
vi.mock('nanoid', () => ({
  nanoid: mockNanoid,
}));

const { initSockets, createNotifier } = await import('../notifier.js');

const createMockSocket = (overrides = {}) => {
  const socket = {
    id: 'socket-1',
    handshake: { query: {}, auth: {} },
    correlationId: undefined,
    decoded_token: undefined,
    on: vi.fn(),
    join: vi.fn(),
    disconnect: vi.fn(),
    ...overrides,
  };
  return socket;
};

const createMockIo = () => ({
  on: vi.fn(),
  to: vi.fn().mockReturnValue({ emit: vi.fn() }),
  sockets: {
    adapter: {
      rooms: new Map(),
    },
  },
});

describe('initSockets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('registers connect handler on io', () => {
    const io = createMockIo();
    initSockets({ serviceId: 'SVC' }, io, () => true);

    expect(io.on).toHaveBeenCalledWith('connect', expect.any(Function));
  });

  test('assigns correlationId from query on connect', () => {
    const io = createMockIo();
    initSockets({ serviceId: 'SVC' }, io, () => true);

    const connectHandler = io.on.mock.calls[0][1];
    const socket = createMockSocket({
      handshake: { query: { correlationId: 'existing-corr' }, auth: {} },
    });
    connectHandler(socket);

    expect(socket.correlationId).toBe('existing-corr');
  });

  test('generates correlationId when not in query', () => {
    const io = createMockIo();
    initSockets({ serviceId: 'SVC' }, io, () => true);

    const connectHandler = io.on.mock.calls[0][1];
    const socket = createMockSocket();
    connectHandler(socket);

    expect(socket.correlationId).toBe('SVC-generated-id');
  });

  test('uses UNK prefix when serviceId is not provided', () => {
    const io = createMockIo();
    initSockets(undefined, io, () => true);

    const connectHandler = io.on.mock.calls[0][1];
    const socket = createMockSocket();
    connectHandler(socket);

    expect(socket.correlationId).toBe('UNK-generated-id');
  });

  test('registers disconnect, error, and register handlers on socket', () => {
    const io = createMockIo();
    initSockets({ serviceId: 'SVC' }, io, () => true);

    const connectHandler = io.on.mock.calls[0][1];
    const socket = createMockSocket();
    connectHandler(socket);

    const eventNames = socket.on.mock.calls.map((c) => c[0]);
    expect(eventNames).toContain('disconnect');
    expect(eventNames).toContain('error');
    expect(eventNames).toContain('register');
  });

  test('extracts encryption scopes from decoded_token on connect', () => {
    const io = createMockIo();
    initSockets({ serviceId: 'SVC' }, io, () => true);

    const connectHandler = io.on.mock.calls[0][1];
    const socket = createMockSocket({
      decoded_token: { sub: 'user-1', scopes: ['personal', 'financial'] },
    });
    connectHandler(socket);

    expect(socket.encryptionScopes).toEqual(['financial', 'personal']);
  });

  test('sets empty scopes when no decoded_token', () => {
    const io = createMockIo();
    initSockets({ serviceId: 'SVC' }, io, () => true);

    const connectHandler = io.on.mock.calls[0][1];
    const socket = createMockSocket();
    connectHandler(socket);

    expect(socket.encryptionScopes).toEqual([]);
  });

  test('uses custom scopeMapper when provided', () => {
    const io = createMockIo();
    const customMapper = vi.fn().mockReturnValue(['custom-scope']);
    initSockets({ serviceId: 'SVC' }, io, () => true, {
      scopeMapper: customMapper,
    });

    const connectHandler = io.on.mock.calls[0][1];
    const socket = createMockSocket({ decoded_token: { sub: 'user-1' } });
    connectHandler(socket);

    expect(customMapper).toHaveBeenCalledWith({ sub: 'user-1' });
    expect(socket.encryptionScopes).toEqual(['custom-scope']);
  });

  test('on register: joins scoped rooms when ioAuthHandler authorizes', () => {
    const io = createMockIo();
    const ioAuthHandler = vi.fn().mockReturnValue(true);
    initSockets({ serviceId: 'SVC' }, io, ioAuthHandler);

    const connectHandler = io.on.mock.calls[0][1];
    const socket = createMockSocket({
      decoded_token: { sub: 'user-1', scopes: ['personal'] },
    });
    connectHandler(socket);

    const registerHandler = socket.on.mock.calls.find(
      (c) => c[0] === 'register',
    )[1];
    const resolvers = [
      {
        endpointName: 'ep',
        readModelName: 'rm',
        resolverName: 'res',
      },
    ];
    registerHandler(resolvers);

    expect(ioAuthHandler).toHaveBeenCalledWith(
      { sub: 'user-1', scopes: ['personal'] },
      resolvers,
    );
    expect(socket.join).toHaveBeenCalledWith(['ep/rm/res:scopes=personal']);
  });

  test('on register: joins scopes=none room when no scopes', () => {
    const io = createMockIo();
    initSockets({ serviceId: 'SVC' }, io, () => true);

    const connectHandler = io.on.mock.calls[0][1];
    const socket = createMockSocket();
    connectHandler(socket);

    const registerHandler = socket.on.mock.calls.find(
      (c) => c[0] === 'register',
    )[1];
    registerHandler([
      { endpointName: 'ep', readModelName: 'rm', resolverName: 'res' },
    ]);

    expect(socket.join).toHaveBeenCalledWith(['ep/rm/res:scopes=none']);
  });

  test('on register: disconnects socket when ioAuthHandler returns false', () => {
    const io = createMockIo();
    const ioAuthHandler = vi.fn().mockReturnValue(false);
    initSockets({ serviceId: 'SVC' }, io, ioAuthHandler);

    const connectHandler = io.on.mock.calls[0][1];
    const socket = createMockSocket();
    connectHandler(socket);

    const registerHandler = socket.on.mock.calls.find(
      (c) => c[0] === 'register',
    )[1];
    registerHandler([
      { endpointName: 'ep', readModelName: 'rm', resolverName: 'res' },
    ]);

    expect(socket.disconnect).toHaveBeenCalled();
    expect(socket.join).not.toHaveBeenCalled();
  });

  test('on register: handles multiple resolvers with scoped rooms', () => {
    const io = createMockIo();
    initSockets({ serviceId: 'SVC' }, io, () => true);

    const connectHandler = io.on.mock.calls[0][1];
    const socket = createMockSocket({
      decoded_token: { scopes: ['admin'] },
    });
    connectHandler(socket);

    const registerHandler = socket.on.mock.calls.find(
      (c) => c[0] === 'register',
    )[1];
    registerHandler([
      { endpointName: 'ep1', readModelName: 'rm1', resolverName: 'res1' },
      { endpointName: 'ep2', readModelName: 'rm2', resolverName: 'res2' },
    ]);

    expect(socket.join).toHaveBeenCalledWith([
      'ep1/rm1/res1:scopes=admin',
      'ep2/rm2/res2:scopes=admin',
    ]);
  });

  test('on register: invokes ack callback on successful registration', () => {
    const io = createMockIo();
    initSockets({ serviceId: 'SVC' }, io, () => true);

    const connectHandler = io.on.mock.calls[0][1];
    const socket = createMockSocket();
    connectHandler(socket);

    const registerHandler = socket.on.mock.calls.find(
      (c) => c[0] === 'register',
    )[1];
    const ack = vi.fn();
    registerHandler(
      [{ endpointName: 'ep', readModelName: 'rm', resolverName: 'res' }],
      ack,
    );

    expect(ack).toHaveBeenCalledWith();
  });

  test('on register: invokes ack callback with error on unauthorized', () => {
    const io = createMockIo();
    initSockets({ serviceId: 'SVC' }, io, () => false);

    const connectHandler = io.on.mock.calls[0][1];
    const socket = createMockSocket();
    connectHandler(socket);

    const registerHandler = socket.on.mock.calls.find(
      (c) => c[0] === 'register',
    )[1];
    const ack = vi.fn();
    registerHandler(
      [{ endpointName: 'ep', readModelName: 'rm', resolverName: 'res' }],
      ack,
    );

    expect(ack).toHaveBeenCalledWith({ error: 'unauthorized' });
  });

  test('on register: invokes ack callback with error on exception', () => {
    const io = createMockIo();
    const ioAuthHandler = vi.fn().mockImplementation(() => {
      throw new Error('auth explosion');
    });
    initSockets({ serviceId: 'SVC' }, io, ioAuthHandler);

    const connectHandler = io.on.mock.calls[0][1];
    const socket = createMockSocket();
    connectHandler(socket);

    const registerHandler = socket.on.mock.calls.find(
      (c) => c[0] === 'register',
    )[1];
    const ack = vi.fn();
    registerHandler(
      [{ endpointName: 'ep', readModelName: 'rm', resolverName: 'res' }],
      ack,
    );

    expect(ack).toHaveBeenCalledWith({ error: 'Error: auth explosion' });
  });

  test('on register: no error when ack callback not provided', () => {
    const io = createMockIo();
    initSockets({ serviceId: 'SVC' }, io, () => true);

    const connectHandler = io.on.mock.calls[0][1];
    const socket = createMockSocket();
    connectHandler(socket);

    const registerHandler = socket.on.mock.calls.find(
      (c) => c[0] === 'register',
    )[1];

    expect(() =>
      registerHandler([
        { endpointName: 'ep', readModelName: 'rm', resolverName: 'res' },
      ]),
    ).not.toThrow();
  });
});

describe('createNotifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('returns a function', () => {
    const io = createMockIo();
    const handler = createNotifier(io, () => true);

    expect(typeof handler).toBe('function');
  });

  test('sends 403 when changeInfoAuthHandler returns false', () => {
    const io = createMockIo();
    const authHandler = vi.fn().mockReturnValue(false);
    const handler = createNotifier(io, authHandler);

    const req = {
      auth: { sub: 'user-1' },
      body: { correlationId: 'corr-1' },
    };
    const res = { sendStatus: vi.fn() };

    handler(req, res);

    expect(authHandler).toHaveBeenCalledWith({ sub: 'user-1' });
    expect(res.sendStatus).toHaveBeenCalledWith(403);
  });

  test('emits change to base room without redaction engine and sends 200', () => {
    const mockEmit = vi.fn();
    const io = createMockIo();
    io.to.mockReturnValue({ emit: mockEmit });
    const handler = createNotifier(io, () => true);

    const req = {
      auth: {},
      body: {
        correlationId: 'corr-1',
        endpointName: 'ep',
        readModelName: 'rm',
        resolverName: 'res',
      },
    };
    const res = { sendStatus: vi.fn() };

    handler(req, res);

    expect(io.to).toHaveBeenCalledWith('ep/rm/res');
    expect(mockEmit).toHaveBeenCalledWith('change', req.body);
    expect(res.sendStatus).toHaveBeenCalledWith(200);
  });

  test('emits redacted payloads to scoped rooms with redaction engine', () => {
    const mockEmit = vi.fn();
    const io = createMockIo();
    io.to.mockReturnValue({ emit: mockEmit });

    // Set up rooms in the adapter
    io.sockets.adapter.rooms.set('ep/rm/res:scopes=admin', new Set(['s1']));
    io.sockets.adapter.rooms.set('ep/rm/res:scopes=none', new Set(['s2']));

    const redactionEngine = {
      redact: vi.fn((payload, scopes) => {
        if (scopes.length === 0) {
          return {
            ...payload,
            name: { unauthorized: true, text: '[redacted]' },
          };
        }
        return payload;
      }),
    };

    const handler = createNotifier(io, () => true, { redactionEngine });

    const req = {
      auth: {},
      body: {
        correlationId: 'corr-1',
        endpointName: 'ep',
        readModelName: 'rm',
        resolverName: 'res',
        name: 'Alice',
      },
    };
    const res = { sendStatus: vi.fn() };

    handler(req, res);

    expect(redactionEngine.redact).toHaveBeenCalledTimes(2);
    expect(redactionEngine.redact).toHaveBeenCalledWith(req.body, ['admin']);
    expect(redactionEngine.redact).toHaveBeenCalledWith(req.body, []);

    expect(io.to).toHaveBeenCalledWith('ep/rm/res:scopes=admin');
    expect(io.to).toHaveBeenCalledWith('ep/rm/res:scopes=none');
    expect(res.sendStatus).toHaveBeenCalledWith(200);
  });

  test('does not emit when no scoped rooms exist with redaction engine', () => {
    const mockEmit = vi.fn();
    const io = createMockIo();
    io.to.mockReturnValue({ emit: mockEmit });

    const redactionEngine = { redact: vi.fn() };
    const handler = createNotifier(io, () => true, { redactionEngine });

    const req = {
      auth: {},
      body: {
        correlationId: 'corr-1',
        endpointName: 'ep',
        readModelName: 'rm',
        resolverName: 'res',
      },
    };
    const res = { sendStatus: vi.fn() };

    handler(req, res);

    expect(redactionEngine.redact).not.toHaveBeenCalled();
    expect(io.to).not.toHaveBeenCalled();
    expect(res.sendStatus).toHaveBeenCalledWith(200);
  });

  test('sends 500 when io.to throws', () => {
    const io = createMockIo();
    io.to.mockImplementation(() => {
      throw new Error('io error');
    });
    const handler = createNotifier(io, () => true);

    const req = {
      auth: {},
      body: {
        correlationId: 'corr-1',
        endpointName: 'ep',
        readModelName: 'rm',
        resolverName: 'res',
      },
    };
    const res = { sendStatus: vi.fn() };

    handler(req, res);

    expect(res.sendStatus).toHaveBeenCalledWith(500);
  });

  test('handles multiple scope groups correctly', () => {
    const mockEmit = vi.fn();
    const io = createMockIo();
    io.to.mockReturnValue({ emit: mockEmit });

    io.sockets.adapter.rooms.set(
      'ep/rm/res:scopes=admin,finance',
      new Set(['s1']),
    );
    io.sockets.adapter.rooms.set('ep/rm/res:scopes=admin', new Set(['s2']));
    io.sockets.adapter.rooms.set('ep/rm/res:scopes=none', new Set(['s3']));
    // This room should NOT be matched (different base)
    io.sockets.adapter.rooms.set('other/rm/res:scopes=admin', new Set(['s4']));

    const redactionEngine = {
      redact: vi.fn((payload) => payload),
    };

    const handler = createNotifier(io, () => true, { redactionEngine });

    const req = {
      auth: {},
      body: {
        correlationId: 'corr-1',
        endpointName: 'ep',
        readModelName: 'rm',
        resolverName: 'res',
      },
    };
    const res = { sendStatus: vi.fn() };

    handler(req, res);

    expect(redactionEngine.redact).toHaveBeenCalledTimes(3);
    expect(io.to).toHaveBeenCalledTimes(3);
    expect(io.to).toHaveBeenCalledWith('ep/rm/res:scopes=admin,finance');
    expect(io.to).toHaveBeenCalledWith('ep/rm/res:scopes=admin');
    expect(io.to).toHaveBeenCalledWith('ep/rm/res:scopes=none');
  });
});
