import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  }),
  safeStringify: (obj) => JSON.stringify(obj),
}));

const mockEmitter = vi.hoisted(() => ({
  emit: vi.fn(),
}));

const mockGetSharedMqEmitter = vi.hoisted(() =>
  vi.fn().mockReturnValue(mockEmitter),
);

vi.mock('../mqEmitterRegistry.js', () => ({
  getSharedMqEmitter: mockGetSharedMqEmitter,
}));

const { commandSenderMqEmitter } = await import('../commandSenderMqEmitter.js');

describe('commandSenderMqEmitter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSharedMqEmitter.mockReturnValue(mockEmitter);
  });

  test('sendCommand emits to command topic', () => {
    const sender = commandSenderMqEmitter({ mqName: 'test-mq' });
    const cmd = { command: 'CREATE', aggregateName: 'thing' };

    return sender.sendCommand('corr-1', cmd).then(() => {
      expect(mockEmitter.emit).toHaveBeenCalledWith({
        topic: 'command',
        payload: cmd,
      });
    });
  });

  test('sendCommand sets correlationId on cmd', () => {
    const sender = commandSenderMqEmitter({ mqName: 'test-mq' });
    const cmd = { command: 'CREATE' };

    return sender.sendCommand('corr-42', cmd).then(() => {
      expect(cmd.correlationId).toBe('corr-42');
    });
  });

  test('sendCommand retrieves emitter by mqName', () => {
    const sender = commandSenderMqEmitter({ mqName: 'my-mq' });
    const cmd = { command: 'CREATE' };

    return sender.sendCommand('corr-1', cmd).then(() => {
      expect(mockGetSharedMqEmitter).toHaveBeenCalledWith('corr-1', 'my-mq');
    });
  });

  test('sendCommand handles emit error gracefully', () => {
    mockEmitter.emit.mockImplementation(() => {
      throw new Error('emit failed');
    });

    const sender = commandSenderMqEmitter({ mqName: 'bad-mq' });
    const cmd = { command: 'CREATE' };

    // Error in emit is caught by the .catch() handler
    return sender.sendCommand('corr-1', cmd);
  });
});
