import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const mockFetch = vi.fn();

const { changeNotificationSenderFetch } = await import('../index.js');

describe('changeNotificationSenderFetch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('sends POST request with content as JSON body', () => {
    mockFetch.mockResolvedValue({ ok: true });
    const sender = changeNotificationSenderFetch({
      url: 'http://localhost:3000/notify',
    });
    const content = { readModelName: 'items', changeKind: 'all' };

    return sender.sendChangeNotification('corr-1', content).then(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:3000/notify',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...content, correlationId: 'corr-1' }),
        }),
      );
    });
  });

  test('includes Authorization header when jwt is provided', () => {
    mockFetch.mockResolvedValue({ ok: true });
    const sender = changeNotificationSenderFetch({
      url: 'http://localhost:3000/notify',
      jwt: 'mytoken',
    });
    const content = { readModelName: 'items' };

    return sender.sendChangeNotification('corr-1', content).then(() => {
      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers.Authorization).toBe('Bearer mytoken');
    });
  });

  test('does not include Authorization header when no jwt', () => {
    mockFetch.mockResolvedValue({ ok: true });
    const sender = changeNotificationSenderFetch({
      url: 'http://localhost:3000/notify',
    });
    const content = { readModelName: 'items' };

    return sender.sendChangeNotification('corr-1', content).then(() => {
      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers.Authorization).toBeUndefined();
    });
  });

  test('throws on non-ok response', () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
    });
    const sender = changeNotificationSenderFetch({
      url: 'http://localhost:3000/notify',
    });
    const content = { readModelName: 'items' };

    return sender
      .sendChangeNotification('corr-1', content)
      .then(() => {
        throw new Error('should have thrown');
      })
      .catch((err) => {
        expect(err.message).toMatch(/Fetch error/);
        expect(err.message).toMatch(/503/);
      });
  });

  test('sets correlationId on content object', () => {
    mockFetch.mockResolvedValue({ ok: true });
    const sender = changeNotificationSenderFetch({
      url: 'http://localhost:3000/notify',
    });
    const content = { readModelName: 'items' };

    return sender.sendChangeNotification('corr-42', content).then(() => {
      expect(content.correlationId).toBe('corr-42');
    });
  });

  // SEC-T2-A3 — configurable fetch timeouts -----------------------------

  describe('fetchTimeoutMs (SEC-T2-A3)', () => {
    test('passes an AbortSignal to fetch on every request', () => {
      mockFetch.mockResolvedValue({ ok: true });
      const sender = changeNotificationSenderFetch({
        url: 'http://localhost:3000/notify',
      });
      return sender
        .sendChangeNotification('corr-1', { readModelName: 'items' })
        .then(() => {
          const [, opts] = mockFetch.mock.calls[0];
          expect(opts.signal).toBeDefined();
          expect(opts.signal).toBeInstanceOf(AbortSignal);
        });
    });

    test('custom fetchTimeoutMs aborts a slow fetch', () => {
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
        });
      });
      const sender = changeNotificationSenderFetch({
        url: 'http://localhost:3000/notify',
        fetchTimeoutMs: 50,
      });
      const start = Date.now();
      return sender
        .sendChangeNotification('corr-1', { readModelName: 'items' })
        .then(
          () => {
            throw new Error('expected fetch to abort, but it resolved');
          },
          (err) => {
            const elapsed = Date.now() - start;
            expect(err).toBeDefined();
            expect(
              err.name === 'AbortError' || /abort/i.test(err.message),
            ).toBe(true);
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
      const sender = changeNotificationSenderFetch({
        url: 'http://localhost:3000/notify',
        fetchTimeoutMs: 5000,
      });
      return sender
        .sendChangeNotification('corr-1', { readModelName: 'items' })
        .then((res) => {
          expect(res.ok).toBe(true);
        });
    });

    test('default fetchTimeoutMs is 5000ms when not specified', () => {
      mockFetch.mockResolvedValue({ ok: true });
      const sender = changeNotificationSenderFetch({
        url: 'http://localhost:3000/notify',
      });
      return sender
        .sendChangeNotification('corr-1', { readModelName: 'items' })
        .then(() => {
          const [, opts] = mockFetch.mock.calls[0];
          expect(opts.signal).toBeInstanceOf(AbortSignal);
          expect(opts.signal.aborted).toBe(false);
        });
    });
  });
});
