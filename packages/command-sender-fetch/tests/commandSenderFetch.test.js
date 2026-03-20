import { describe, test, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.mock('isomorphic-fetch', () => ({ default: mockFetch }));

const { commandSenderFetch } = await import('../index.js');

describe('commandSenderFetch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('sends POST request with command as JSON body', () => {
    mockFetch.mockResolvedValue({ ok: true });
    const sender = commandSenderFetch({ url: 'http://localhost:3000/api' });
    const cmd = { command: 'CREATE', aggregateName: 'thing' };

    return sender.sendCommand('corr-1', cmd).then(() => {
      expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...cmd, correlationId: 'corr-1' }),
      });
    });
  });

  test('includes Authorization header when jwt is provided', () => {
    mockFetch.mockResolvedValue({ ok: true });
    const sender = commandSenderFetch({
      url: 'http://localhost:3000/api',
      jwt: 'mytoken',
    });
    const cmd = { command: 'CREATE' };

    return sender.sendCommand('corr-1', cmd).then(() => {
      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers.Authorization).toBe('Bearer mytoken');
    });
  });

  test('does not include Authorization header when no jwt', () => {
    mockFetch.mockResolvedValue({ ok: true });
    const sender = commandSenderFetch({ url: 'http://localhost:3000/api' });
    const cmd = { command: 'CREATE' };

    return sender.sendCommand('corr-1', cmd).then(() => {
      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers.Authorization).toBeUndefined();
    });
  });

  test('throws on non-ok response', () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });
    const sender = commandSenderFetch({ url: 'http://localhost:3000/api' });
    const cmd = { command: 'CREATE' };

    return sender
      .sendCommand('corr-1', cmd)
      .then(() => {
        throw new Error('should have thrown');
      })
      .catch((err) => {
        expect(err.message).toMatch(/Fetch error/);
        expect(err.message).toMatch(/500/);
      });
  });

  test('accepts jwt as a sync function', () => {
    mockFetch.mockResolvedValue({ ok: true });
    const sender = commandSenderFetch({
      url: 'http://localhost:3000/api',
      jwt: () => 'dynamic-token',
    });
    const cmd = { command: 'CREATE' };

    return sender.sendCommand('corr-1', cmd).then(() => {
      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers.Authorization).toBe('Bearer dynamic-token');
    });
  });

  test('accepts jwt as an async function', () => {
    mockFetch.mockResolvedValue({ ok: true });
    const sender = commandSenderFetch({
      url: 'http://localhost:3000/api',
      jwt: () => Promise.resolve('async-token'),
    });
    const cmd = { command: 'CREATE' };

    return sender.sendCommand('corr-1', cmd).then(() => {
      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers.Authorization).toBe('Bearer async-token');
    });
  });

  test('calls jwt function on each sendCommand invocation', () => {
    mockFetch.mockResolvedValue({ ok: true });
    let callCount = 0;
    const sender = commandSenderFetch({
      url: 'http://localhost:3000/api',
      jwt: () => `token-${++callCount}`,
    });

    return sender
      .sendCommand('corr-1', { command: 'A' })
      .then(() => sender.sendCommand('corr-2', { command: 'B' }))
      .then(() => {
        const [, opts1] = mockFetch.mock.calls[0];
        const [, opts2] = mockFetch.mock.calls[1];
        expect(opts1.headers.Authorization).toBe('Bearer token-1');
        expect(opts2.headers.Authorization).toBe('Bearer token-2');
      });
  });

  test('sets correlationId on cmd object', () => {
    mockFetch.mockResolvedValue({ ok: true });
    const sender = commandSenderFetch({ url: 'http://localhost:3000/api' });
    const cmd = { command: 'CREATE' };

    return sender.sendCommand('corr-42', cmd).then(() => {
      expect(cmd.correlationId).toBe('corr-42');
    });
  });
});
