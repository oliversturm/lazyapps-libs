import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  }),
}));

const { mockServer, mockCreateServer, mockConnect } = vi.hoisted(() => {
  const mockServer = { on: vi.fn(), listen: vi.fn() };
  return {
    mockServer,
    mockCreateServer: vi.fn().mockReturnValue(mockServer),
    mockConnect: vi.fn().mockReturnValue('mock-socket'),
  };
});

vi.mock('node:net', () => ({
  default: {
    createServer: mockCreateServer,
    connect: mockConnect,
  },
}));

const { mockCsServer, mockCsClient } = vi.hoisted(() => ({
  mockCsServer: vi.fn().mockReturnValue('mock-cs-server'),
  mockCsClient: vi.fn().mockReturnValue('mock-cs-client'),
}));

vi.mock('mqemitter-cs', () => ({
  default: {
    server: mockCsServer,
    client: mockCsClient,
  },
}));

const { registerSharedMqEmitter, getSharedMqEmitter, getPublishedMqEmitter } =
  await import('../mqEmitterRegistry.js');

describe('mqEmitterRegistry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('registerSharedMqEmitter stores emitter and getSharedMqEmitter retrieves it', () => {
    const emitter = { emit: vi.fn() };
    registerSharedMqEmitter('test-emitter', emitter);
    const result = getSharedMqEmitter('corr-1', 'test-emitter');
    expect(result).toBe(emitter);
  });

  test('getSharedMqEmitter throws when emitter not registered', () => {
    expect(() => getSharedMqEmitter('corr-1', 'nonexistent')).toThrow(
      'No shared MQ emitter registered for name: nonexistent',
    );
  });

  test('registerSharedMqEmitter creates server when port is provided', () => {
    const emitter = { emit: vi.fn() };
    registerSharedMqEmitter('server-emitter', emitter, 9999);

    expect(mockCsServer).toHaveBeenCalledWith(emitter);
    expect(mockCreateServer).toHaveBeenCalledWith('mock-cs-server');
    // Regression guard for security review #26: the MQ emitter
    // TCP socket must only bind to the loopback interface.
    expect(mockServer.listen).toHaveBeenCalledWith(9999, '127.0.0.1');
  });

  test('registerSharedMqEmitter does not create server when no port', () => {
    const emitter = { emit: vi.fn() };
    registerSharedMqEmitter('no-server-emitter', emitter);

    expect(mockCreateServer).not.toHaveBeenCalled();
  });

  test('getPublishedMqEmitter creates client connection', () => {
    const result = getPublishedMqEmitter('corr-1', 8888);

    expect(mockConnect).toHaveBeenCalledWith(8888);
    expect(mockCsClient).toHaveBeenCalledWith('mock-socket');
    expect(result).toBe('mock-cs-client');
  });
});
