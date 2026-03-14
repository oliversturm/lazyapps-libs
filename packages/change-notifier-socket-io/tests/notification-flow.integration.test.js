import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debugBare: vi.fn(),
  }),
}));

vi.mock('nanoid', () => ({
  nanoid: vi.fn().mockReturnValue('test-id'),
}));

const { initSockets, createNotifier } = await import('../notifier.js');
const { createRedactionEngine, defaultScopeMapper } =
  await import('../redaction.js');

// Simulates the Socket.io adapter room tracking that happens
// when sockets join rooms. This enables the notifier to discover
// which scope groups exist when emitting change notifications.
const createMockIoWithRoomTracking = () => {
  const rooms = new Map();
  const emittedPayloads = new Map(); // roomName -> [payloads]

  const io = {
    on: vi.fn(),
    to: vi.fn((roomName) => ({
      emit: vi.fn((eventName, payload) => {
        if (!emittedPayloads.has(roomName)) {
          emittedPayloads.set(roomName, []);
        }
        emittedPayloads.get(roomName).push({ eventName, payload });
      }),
    })),
    sockets: {
      adapter: { rooms },
    },
  };

  // Simulates a socket connecting and registering for resolvers.
  // Returns the emitted payloads map for assertions.
  const connectAndRegister = (decodedToken, resolvers) => {
    const connectHandler = io.on.mock.calls.find((c) => c[0] === 'connect')[1];

    const socket = {
      id: `socket-${Math.random().toString(36).slice(2)}`,
      handshake: { query: {}, auth: {} },
      decoded_token: decodedToken,
      on: vi.fn(),
      join: vi.fn((roomNames) => {
        for (const name of roomNames) {
          if (!rooms.has(name)) rooms.set(name, new Set());
          rooms.get(name).add(socket.id);
        }
      }),
      disconnect: vi.fn(),
    };

    connectHandler(socket);

    const registerHandler = socket.on.mock.calls.find(
      (c) => c[0] === 'register',
    )[1];
    registerHandler(resolvers);

    return socket;
  };

  return { io, rooms, emittedPayloads, connectAndRegister };
};

const mockReq = (body) => ({
  auth: {},
  body: { correlationId: 'corr-test', ...body },
});

const mockRes = () => ({ sendStatus: vi.fn() });

const createMockSchema = () => ({
  getUnauthorizedText: (fieldName, contextName) =>
    `[${contextName} restricted]`,
  getForgottenText: (fieldName, contextName) => `[${contextName} deleted]`,
});

describe('change notification integration flow', () => {
  const resolvers = [
    {
      endpointName: 'ep',
      readModelName: 'customers',
      resolverName: 'all',
    },
  ];

  const contexts = {
    personal: {
      roles: ['admin', 'hr'],
      fields: { name: {}, location: {} },
    },
    financial: {
      roles: ['finance'],
      fields: { balance: {} },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('clients with different scopes receive differently redacted payloads', () => {
    const { io, emittedPayloads, connectAndRegister } =
      createMockIoWithRoomTracking();
    const schema = createMockSchema();

    initSockets({ serviceId: 'SVC' }, io, () => true, {
      scopeMapper: defaultScopeMapper,
    });

    // Client A: has 'admin' scope (sees personal data)
    connectAndRegister({ sub: 'admin-user', scopes: ['admin'] }, resolvers);

    // Client B: has no scopes (sees nothing)
    connectAndRegister(null, resolvers);

    // Client C: has 'finance' scope (sees financial data)
    connectAndRegister({ sub: 'finance-user', scopes: ['finance'] }, resolvers);

    const redactionEngine = createRedactionEngine({ schema, contexts });
    const handler = createNotifier(io, () => true, { redactionEngine });

    const changeInfo = {
      endpointName: 'ep',
      readModelName: 'customers',
      resolverName: 'all',
      name: 'Alice',
      balance: 500,
    };

    const res = mockRes();
    handler(mockReq(changeInfo), res);

    expect(res.sendStatus).toHaveBeenCalledWith(200);

    // Admin client: name visible (personal scope), balance redacted
    const adminPayloads = emittedPayloads.get('ep/customers/all:scopes=admin');
    expect(adminPayloads).toHaveLength(1);
    expect(adminPayloads[0].payload.name).toBe('Alice');
    expect(adminPayloads[0].payload.balance).toEqual({
      restricted: true,
      text: '[financial restricted]',
    });

    // No-scope client: everything redacted
    const nonePayloads = emittedPayloads.get('ep/customers/all:scopes=none');
    expect(nonePayloads).toHaveLength(1);
    expect(nonePayloads[0].payload.name).toEqual({
      restricted: true,
      text: '[personal restricted]',
    });
    expect(nonePayloads[0].payload.balance).toEqual({
      restricted: true,
      text: '[financial restricted]',
    });

    // Finance client: balance visible, name redacted
    const financePayloads = emittedPayloads.get(
      'ep/customers/all:scopes=finance',
    );
    expect(financePayloads).toHaveLength(1);
    expect(financePayloads[0].payload.name).toEqual({
      restricted: true,
      text: '[personal restricted]',
    });
    expect(financePayloads[0].payload.balance).toBe(500);
  });

  test('client with no scopes receives fully redacted payload', () => {
    const { io, emittedPayloads, connectAndRegister } =
      createMockIoWithRoomTracking();
    const schema = createMockSchema();

    initSockets({ serviceId: 'SVC' }, io, () => true, {
      scopeMapper: defaultScopeMapper,
    });
    connectAndRegister(null, resolvers);

    const redactionEngine = createRedactionEngine({ schema, contexts });
    const handler = createNotifier(io, () => true, { redactionEngine });

    const changeInfo = {
      endpointName: 'ep',
      readModelName: 'customers',
      resolverName: 'all',
      name: 'Bob',
      location: 'Berlin',
      balance: 1000,
    };

    const res = mockRes();
    handler(mockReq(changeInfo), res);

    const payloads = emittedPayloads.get('ep/customers/all:scopes=none');
    expect(payloads).toHaveLength(1);
    expect(payloads[0].payload.name).toEqual({
      restricted: true,
      text: '[personal restricted]',
    });
    expect(payloads[0].payload.location).toEqual({
      restricted: true,
      text: '[personal restricted]',
    });
    expect(payloads[0].payload.balance).toEqual({
      restricted: true,
      text: '[financial restricted]',
    });
  });

  test('client with full scopes receives unredacted payload', () => {
    const { io, emittedPayloads, connectAndRegister } =
      createMockIoWithRoomTracking();
    const schema = createMockSchema();

    initSockets({ serviceId: 'SVC' }, io, () => true, {
      scopeMapper: defaultScopeMapper,
    });
    connectAndRegister(
      { sub: 'superuser', scopes: ['admin', 'finance'] },
      resolvers,
    );

    const redactionEngine = createRedactionEngine({ schema, contexts });
    const handler = createNotifier(io, () => true, { redactionEngine });

    const changeInfo = {
      endpointName: 'ep',
      readModelName: 'customers',
      resolverName: 'all',
      name: 'Charlie',
      location: 'Paris',
      balance: 2000,
    };

    const res = mockRes();
    handler(mockReq(changeInfo), res);

    const payloads = emittedPayloads.get(
      'ep/customers/all:scopes=admin,finance',
    );
    expect(payloads).toHaveLength(1);
    expect(payloads[0].payload.name).toBe('Charlie');
    expect(payloads[0].payload.location).toBe('Paris');
    expect(payloads[0].payload.balance).toBe(2000);
  });

  test('custom redaction hooks are applied after schema redaction', () => {
    const { io, emittedPayloads, connectAndRegister } =
      createMockIoWithRoomTracking();
    const schema = createMockSchema();

    initSockets({ serviceId: 'SVC' }, io, () => true, {
      scopeMapper: defaultScopeMapper,
    });

    // Client with admin scope
    connectAndRegister({ sub: 'admin-user', scopes: ['admin'] }, resolvers);

    // Client with no scopes
    connectAndRegister(null, resolvers);

    const customHook = (payload, scopes) => {
      const scopeSet = new Set(scopes);
      return {
        ...payload,
        computedScore: scopeSet.has('admin')
          ? payload.computedScore
          : '[hidden]',
      };
    };

    const redactionEngine = createRedactionEngine({
      schema,
      contexts,
      redactionHooks: { customers: customHook },
    });
    const handler = createNotifier(io, () => true, { redactionEngine });

    const changeInfo = {
      endpointName: 'ep',
      readModelName: 'customers',
      resolverName: 'all',
      name: 'Diana',
      computedScore: 95,
    };

    const res = mockRes();
    handler(mockReq(changeInfo), res);

    // Admin sees full data (schema + hook pass through)
    const adminPayloads = emittedPayloads.get('ep/customers/all:scopes=admin');
    expect(adminPayloads[0].payload.name).toBe('Diana');
    expect(adminPayloads[0].payload.computedScore).toBe(95);

    // No-scope client: schema redacts name, hook redacts computedScore
    const nonePayloads = emittedPayloads.get('ep/customers/all:scopes=none');
    expect(nonePayloads[0].payload.name).toEqual({
      restricted: true,
      text: '[personal restricted]',
    });
    expect(nonePayloads[0].payload.computedScore).toBe('[hidden]');
  });

  test('encrypted field markers in payload are redacted for unauthorized scopes', () => {
    const { io, emittedPayloads, connectAndRegister } =
      createMockIoWithRoomTracking();
    const schema = createMockSchema();

    initSockets({ serviceId: 'SVC' }, io, () => true, {
      scopeMapper: defaultScopeMapper,
    });
    connectAndRegister(null, resolvers);
    connectAndRegister({ sub: 'admin-user', scopes: ['admin'] }, resolvers);

    const redactionEngine = createRedactionEngine({ schema, contexts });
    const handler = createNotifier(io, () => true, { redactionEngine });

    const changeInfo = {
      endpointName: 'ep',
      readModelName: 'customers',
      resolverName: 'all',
      name: { __encrypted: true, ctx: 'personal', data: 'enc-blob' },
      status: 'active',
    };

    const res = mockRes();
    handler(mockReq(changeInfo), res);

    // No-scope client: encrypted field redacted
    const nonePayloads = emittedPayloads.get('ep/customers/all:scopes=none');
    expect(nonePayloads[0].payload.name).toEqual({
      restricted: true,
      text: '[personal restricted]',
    });
    expect(nonePayloads[0].payload.status).toBe('active');

    // Admin client: encrypted field left intact (has personal scope)
    const adminPayloads = emittedPayloads.get('ep/customers/all:scopes=admin');
    expect(adminPayloads[0].payload.name).toEqual({
      __encrypted: true,
      ctx: 'personal',
      data: 'enc-blob',
    });
    expect(adminPayloads[0].payload.status).toBe('active');
  });

  test('multiple clients with same scopes share a room and receive same payload', () => {
    const { io, emittedPayloads, connectAndRegister } =
      createMockIoWithRoomTracking();
    const schema = createMockSchema();

    initSockets({ serviceId: 'SVC' }, io, () => true, {
      scopeMapper: defaultScopeMapper,
    });

    // Two clients with identical scopes
    connectAndRegister({ sub: 'user-1', scopes: ['admin'] }, resolvers);
    connectAndRegister({ sub: 'user-2', scopes: ['admin'] }, resolvers);

    const redactionEngine = createRedactionEngine({ schema, contexts });
    const handler = createNotifier(io, () => true, { redactionEngine });

    const changeInfo = {
      endpointName: 'ep',
      readModelName: 'customers',
      resolverName: 'all',
      name: 'Eve',
    };

    const res = mockRes();
    handler(mockReq(changeInfo), res);

    // Only one emit to the shared room (not two separate emits)
    const adminPayloads = emittedPayloads.get('ep/customers/all:scopes=admin');
    expect(adminPayloads).toHaveLength(1);
    expect(adminPayloads[0].payload.name).toBe('Eve');
  });

  test('without redaction engine, notifications go to base room (backwards-compatible)', () => {
    const { io, connectAndRegister } = createMockIoWithRoomTracking();

    initSockets({ serviceId: 'SVC' }, io, () => true);
    connectAndRegister(null, resolvers);

    // No redaction engine — backwards-compatible mode
    const handler = createNotifier(io, () => true);

    const changeInfo = {
      endpointName: 'ep',
      readModelName: 'customers',
      resolverName: 'all',
      name: 'Frank',
    };

    const res = mockRes();
    handler(mockReq(changeInfo), res);

    // Falls back to base room name (no scopes suffix)
    expect(io.to).toHaveBeenCalledWith('ep/customers/all');
    expect(res.sendStatus).toHaveBeenCalledWith(200);
  });
});
