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

const { getLogger, getStream } = await import('../index.js');

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
