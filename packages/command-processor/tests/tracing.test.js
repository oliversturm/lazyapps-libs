import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockSpan, mockStartActiveSpan } = vi.hoisted(() => {
  const mockSpan = {
    end: vi.fn(),
    recordException: vi.fn(),
    setStatus: vi.fn(),
  };
  const mockStartActiveSpan = vi.fn((name, opts, fn) => fn(mockSpan));
  return { mockSpan, mockStartActiveSpan };
});

vi.mock('@opentelemetry/api', () => ({
  trace: {
    getTracer: vi.fn(() => ({
      startActiveSpan: mockStartActiveSpan,
    })),
  },
  SpanStatusCode: { ERROR: 2 },
}));

const { withSpan } = await import('../tracing.js');

describe('withSpan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('creates a span with given name and attributes', () =>
    withSpan('test.span', { key: 'value' }, () => Promise.resolve('ok')).then(
      () => {
        expect(mockStartActiveSpan).toHaveBeenCalledWith(
          'test.span',
          { attributes: { key: 'value' } },
          expect.any(Function),
        );
      },
    ));

  test('returns the result of the function', () =>
    withSpan('test.span', {}, () => Promise.resolve('result')).then(
      (result) => {
        expect(result).toBe('result');
      },
    ));

  test('ends the span on success', () =>
    withSpan('test.span', {}, () => Promise.resolve('ok')).then(() => {
      expect(mockSpan.end).toHaveBeenCalledOnce();
    }));

  test('records exception and sets error status on failure', () => {
    const error = new Error('test error');
    return withSpan('test.span', {}, () => Promise.reject(error)).catch(
      (err) => {
        expect(err).toBe(error);
        expect(mockSpan.recordException).toHaveBeenCalledWith(error);
        expect(mockSpan.setStatus).toHaveBeenCalledWith({
          code: 2,
          message: 'test error',
        });
      },
    );
  });

  test('ends the span on failure', () => {
    const error = new Error('test error');
    return withSpan('test.span', {}, () => Promise.reject(error)).catch(() => {
      expect(mockSpan.end).toHaveBeenCalledOnce();
    });
  });

  test('re-throws the error after recording it', () => {
    const error = new Error('rethrown');
    return withSpan('test.span', {}, () => Promise.reject(error)).then(
      () => {
        throw new Error('should not reach here');
      },
      (err) => {
        expect(err).toBe(error);
      },
    );
  });

  test('works with synchronous return values from fn', () =>
    withSpan('test.span', {}, () => 'sync-value').then((result) => {
      expect(result).toBe('sync-value');
      expect(mockSpan.end).toHaveBeenCalledOnce();
    }));

  test('passes span to the callback function', () => {
    const fn = vi.fn(() => Promise.resolve('ok'));
    return withSpan('test.span', {}, fn).then(() => {
      expect(fn).toHaveBeenCalledWith(mockSpan);
    });
  });
});
