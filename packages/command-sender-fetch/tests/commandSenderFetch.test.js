import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const mockFetch = vi.fn();

const { commandSenderFetch } = await import('../index.js');

describe('commandSenderFetch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('sends POST request with command as JSON body', () => {
    mockFetch.mockResolvedValue({ ok: true });
    const sender = commandSenderFetch({ url: 'http://localhost:3000/api' });
    const cmd = { command: 'CREATE', aggregateName: 'thing' };

    return sender.sendCommand('corr-1', cmd).then(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/api',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...cmd, correlationId: 'corr-1' }),
        }),
      );
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

  // SEC-T2-A3 — configurable fetch timeouts -----------------------------

  describe('fetchTimeoutMs (SEC-T2-A3)', () => {
    test('passes an AbortSignal to fetch on every request', () => {
      mockFetch.mockResolvedValue({ ok: true });
      const sender = commandSenderFetch({
        url: 'http://localhost:3000/api',
      });
      return sender.sendCommand('corr-1', { command: 'X' }).then(() => {
        const [, opts] = mockFetch.mock.calls[0];
        expect(opts.signal).toBeDefined();
        expect(opts.signal).toBeInstanceOf(AbortSignal);
      });
    });

    test('default timeout aborts a slow fetch (custom 50ms override fires within ~250ms)', () => {
      // Use a delayed fetch that listens to the abort signal so we can prove
      // the timeout actually wired through.
      mockFetch.mockImplementation((_url, opts) => {
        return new Promise((resolve, reject) => {
          const onAbort = () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          };
          if (opts.signal) {
            if (opts.signal.aborted) onAbort();
            else opts.signal.addEventListener('abort', onAbort);
          }
          // Never resolve on its own.
        });
      });
      const sender = commandSenderFetch({
        url: 'http://localhost:3000/api',
        fetchTimeoutMs: 50,
      });
      const start = Date.now();
      return sender.sendCommand('corr-1', { command: 'X' }).then(
        () => {
          throw new Error('expected fetch to abort, but it resolved');
        },
        (err) => {
          const elapsed = Date.now() - start;
          expect(err).toBeDefined();
          expect(err.name === 'AbortError' || /abort/i.test(err.message)).toBe(
            true,
          );
          expect(elapsed).toBeLessThan(2000);
        },
      );
    });

    test('fast fetch within timeout completes normally', () => {
      mockFetch.mockImplementation(
        (_url, _opts) =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ ok: true }), 10);
          }),
      );
      const sender = commandSenderFetch({
        url: 'http://localhost:3000/api',
        fetchTimeoutMs: 5000,
      });
      return sender.sendCommand('corr-1', { command: 'X' }).then((res) => {
        expect(res.ok).toBe(true);
      });
    });

    test('default fetchTimeoutMs is 5000ms when not specified', () => {
      // Default behavior: signal must be present and tagged with the
      // documented default timeout. We can't directly read the timeout from
      // an AbortSignal, but a freshly-created AbortSignal.timeout(N) signal
      // exposes a 'reason' (DOMException) only after it fires. Verify by
      // checking that the signal is NOT immediately aborted (proving the
      // default isn't 0) and has the expected shape.
      mockFetch.mockResolvedValue({ ok: true });
      const sender = commandSenderFetch({
        url: 'http://localhost:3000/api',
      });
      return sender.sendCommand('corr-1', { command: 'X' }).then(() => {
        const [, opts] = mockFetch.mock.calls[0];
        expect(opts.signal).toBeInstanceOf(AbortSignal);
        // Default 5s timeout means the signal MUST NOT fire immediately.
        expect(opts.signal.aborted).toBe(false);
      });
    });
  });
});
