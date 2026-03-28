import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockActive, mockWith } = vi.hoisted(() => {
  const mockActive = vi.fn(() => 'captured-context');
  const mockWith = vi.fn((ctx, fn) => fn());
  return { mockActive, mockWith };
});

vi.mock('@opentelemetry/api', () => ({
  context: {
    active: mockActive,
    with: mockWith,
  },
}));

vi.mock('promise-queue', () => {
  const MockQueue = vi.fn(function () {
    this._queue = [];
    this._queueLength = 0;
    this.add = vi.fn((generator) => {
      this._queueLength++;
      return Promise.resolve().then(() => {
        this._queueLength--;
        return generator();
      });
    });
    this.getQueueLength = vi.fn(() => this._queueLength);
  });
  return { default: MockQueue };
});

// Reset module cache to ensure contextQueue.js picks up our mocks
// (prevents stale real @opentelemetry/api from other test files)
vi.resetModules();
const { createContextQueue } = await import('../contextQueue.js');

describe('createContextQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mockActive to default — some tests override with
    // mockImplementation which clearAllMocks does NOT reset
    mockActive.mockImplementation(() => 'captured-context');
  });

  test('returns object with add and getQueueLength', () => {
    const queue = createContextQueue(1, Infinity);
    expect(typeof queue.add).toBe('function');
    expect(typeof queue.getQueueLength).toBe('function');
  });

  test('captures active context at enqueue time', () =>
    createContextQueue(1, Infinity)
      .add(() => Promise.resolve('done'))
      .then(() => {
        expect(mockActive).toHaveBeenCalled();
      }));

  test('restores captured context at execution time', () =>
    createContextQueue(1, Infinity)
      .add(() => Promise.resolve('done'))
      .then(() => {
        expect(mockWith).toHaveBeenCalledWith(
          'captured-context',
          expect.any(Function),
        );
      }));

  test('executes the promise generator and returns its result', () =>
    createContextQueue(1, Infinity)
      .add(() => Promise.resolve('result-value'))
      .then((result) => {
        expect(result).toBe('result-value');
      }));

  test('captures different contexts for different add calls', () => {
    let callCount = 0;
    mockActive.mockImplementation(() => `context-${++callCount}`);

    const queue = createContextQueue(1, Infinity);
    return Promise.all([
      queue.add(() => Promise.resolve('a')),
      queue.add(() => Promise.resolve('b')),
    ]).then(() => {
      expect(mockWith).toHaveBeenCalledWith('context-1', expect.any(Function));
      expect(mockWith).toHaveBeenCalledWith('context-2', expect.any(Function));
    });
  });

  test('propagates errors from promise generator', () => {
    const error = new Error('queue error');
    return createContextQueue(1, Infinity)
      .add(() => Promise.reject(error))
      .then(
        () => {
          throw new Error('should not reach here');
        },
        (err) => {
          expect(err).toBe(error);
        },
      );
  });

  test('getQueueLength delegates to underlying queue', () => {
    const queue = createContextQueue(1, Infinity);
    const length = queue.getQueueLength();
    expect(typeof length).toBe('number');
  });
});
