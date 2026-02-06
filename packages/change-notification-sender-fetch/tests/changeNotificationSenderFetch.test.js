import { describe, test, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.mock('isomorphic-fetch', () => ({ default: mockFetch }));

const { changeNotificationSenderFetch } = await import('../index.js');

describe('changeNotificationSenderFetch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('sends POST request with content as JSON body', () => {
    mockFetch.mockResolvedValue({ ok: true });
    const sender = changeNotificationSenderFetch({
      url: 'http://localhost:3000/notify',
    });
    const content = { readModelName: 'items', changeKind: 'all' };

    return sender.sendChangeNotification('corr-1', content).then(() => {
      expect(mockFetch).toHaveBeenCalledWith('http://localhost:3000/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...content, correlationId: 'corr-1' }),
      });
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
});
