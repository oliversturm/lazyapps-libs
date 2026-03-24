import { describe, test, expect, vi, beforeEach } from 'vitest';

const mockLogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  log: vi.fn(),
};

vi.mock('loglevel', () => {
  const getLogger = vi.fn().mockReturnValue(mockLogger);
  return {
    default: {
      getLogger,
      setLevel: vi.fn(),
    },
  };
});

vi.mock('loglevel-plugin-prefix', () => ({
  default: {
    reg: vi.fn(),
    apply: vi.fn(),
  },
}));

const { getLogger, getStream, configurePiiPaths, safeStringify } =
  await import('../index.js');

describe('getLogger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('returns object with all expected methods', () => {
    const log = getLogger('Test', 'corr-1');
    expect(typeof log.trace).toBe('function');
    expect(typeof log.debug).toBe('function');
    expect(typeof log.info).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.error).toBe('function');
    expect(typeof log.log).toBe('function');
    expect(typeof log.traceBare).toBe('function');
    expect(typeof log.debugBare).toBe('function');
    expect(typeof log.infoBare).toBe('function');
    expect(typeof log.warnBare).toBe('function');
    expect(typeof log.errorBare).toBe('function');
    expect(typeof log.logBare).toBe('function');
  });

  test('prefixes messages with correlation ID', () => {
    const log = getLogger('Test', 'corr-123');
    log.debug('test message');
    expect(mockLogger.debug).toHaveBeenCalledWith('[corr-123] test message');
  });

  test('uses CORR-NONE when no correlation ID provided', () => {
    const log = getLogger('Test');
    log.info('test message');
    expect(mockLogger.info).toHaveBeenCalledWith('[CORR-NONE] test message');
  });

  test('all bare methods delegate without correlation ID prefix', () => {
    const log = getLogger('Test', 'corr-456');
    log.traceBare('t');
    log.debugBare('d');
    log.infoBare('i');
    log.warnBare('w');
    log.errorBare('e');
    log.logBare('l');
    expect(mockLogger.trace).toHaveBeenCalledWith('t');
    expect(mockLogger.debug).toHaveBeenCalledWith('d');
    expect(mockLogger.info).toHaveBeenCalledWith('i');
    expect(mockLogger.warn).toHaveBeenCalledWith('w');
    expect(mockLogger.error).toHaveBeenCalledWith('e');
    expect(mockLogger.log).toHaveBeenCalledWith('l');
  });

  test('all log levels delegate to underlying logger', () => {
    const log = getLogger('Test', 'c');
    log.trace('t');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    log.log('l');
    expect(mockLogger.trace).toHaveBeenCalledWith('[c] t');
    expect(mockLogger.debug).toHaveBeenCalledWith('[c] d');
    expect(mockLogger.info).toHaveBeenCalledWith('[c] i');
    expect(mockLogger.warn).toHaveBeenCalledWith('[c] w');
    expect(mockLogger.error).toHaveBeenCalledWith('[c] e');
    expect(mockLogger.log).toHaveBeenCalledWith('[c] l');
  });
});

describe('safeStringify / PII redaction', () => {
  beforeEach(() => {
    configurePiiPaths([]);
  });

  test('without PII paths, serializes normally', () => {
    const obj = { payload: { name: 'Alice', age: 30 } };
    expect(safeStringify(obj)).toBe(JSON.stringify(obj));
  });

  test('redacts configured PII paths', () => {
    configurePiiPaths(['payload.name', 'payload.email']);
    const obj = {
      type: 'CUSTOMER_CREATED',
      payload: { name: 'Alice', email: 'alice@example.com', age: 30 },
    };
    const result = JSON.parse(safeStringify(obj));
    expect(result.type).toBe('CUSTOMER_CREATED');
    expect(result.payload.name).toBe('[PII]');
    expect(result.payload.email).toBe('[PII]');
    expect(result.payload.age).toBe(30);
  });

  test('handles missing intermediate paths gracefully', () => {
    configurePiiPaths(['payload.name']);
    const obj = { type: 'SOME_EVENT' };
    expect(safeStringify(obj)).toBe(JSON.stringify(obj));
  });

  test('handles null values in path gracefully', () => {
    configurePiiPaths(['payload.name']);
    const obj = { payload: null };
    expect(safeStringify(obj)).toBe(JSON.stringify(obj));
  });

  test('does not mutate the original object', () => {
    configurePiiPaths(['payload.name']);
    const obj = { payload: { name: 'Alice' } };
    safeStringify(obj);
    expect(obj.payload.name).toBe('Alice');
  });

  test('handles deeply nested paths', () => {
    configurePiiPaths(['a.b.c.d']);
    const obj = { a: { b: { c: { d: 'secret', e: 'safe' } } } };
    const result = JSON.parse(safeStringify(obj));
    expect(result.a.b.c.d).toBe('[PII]');
    expect(result.a.b.c.e).toBe('safe');
  });

  test('handles multiple paths in same parent', () => {
    configurePiiPaths(['payload.name', 'payload.email']);
    const obj = { payload: { name: 'Alice', email: 'a@b.com', id: 1 } };
    const result = JSON.parse(safeStringify(obj));
    expect(result.payload.name).toBe('[PII]');
    expect(result.payload.email).toBe('[PII]');
    expect(result.payload.id).toBe(1);
  });

  test('returns primitives unchanged', () => {
    configurePiiPaths(['payload.name']);
    expect(safeStringify('hello')).toBe('"hello"');
    expect(safeStringify(42)).toBe('42');
    expect(safeStringify(null)).toBe('null');
  });
});

describe('getStream', () => {
  test('creates a writable stream that calls output function', () => {
    const output = vi.fn();
    const stream = getStream(output);
    return new Promise((resolve) => {
      stream.write('test output\n', () => {
        expect(output).toHaveBeenCalledWith('test output');
        resolve();
      });
    });
  });

  test('trims whitespace from output', () => {
    const output = vi.fn();
    const stream = getStream(output);
    return new Promise((resolve) => {
      stream.write('  padded  \n', () => {
        expect(output).toHaveBeenCalledWith('padded');
        resolve();
      });
    });
  });
});
