import { describe, test, expect, vi, beforeEach } from 'vitest';

const mockEmit = vi.fn();
const mockGetLogger = vi.fn(() => ({ emit: mockEmit }));

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

const mockOtelApis = {
  logs: { getLogger: mockGetLogger },
  SeverityNumber: {
    TRACE: 1,
    DEBUG: 5,
    INFO: 9,
    WARN: 13,
    ERROR: 17,
  },
  trace: { getSpanContext: vi.fn() },
  context: { active: vi.fn() },
};

const { getLogger, configureOtel, __resetOtelForTesting } =
  await import('../index.js');

describe('configureOtel', () => {
  beforeEach(() => {
    __resetOtelForTesting();
    vi.clearAllMocks();
  });

  test('enables OTEL log emission after configureOtel', () => {
    configureOtel(mockOtelApis);
    const log = getLogger('Test', 'corr-1');
    log.info('hello');
    expect(mockEmit).toHaveBeenCalledOnce();
  });

  test('emits OTEL log records with correct severity', () => {
    configureOtel(mockOtelApis);
    const log = getLogger('Test', 'corr-1');
    log.info('info msg');
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        severityNumber: 9,
        severityText: 'INFO',
      }),
    );
  });

  test('emits OTEL log records with logger name and correlation ID', () => {
    configureOtel(mockOtelApis);
    const log = getLogger('MyService', 'req-456');
    log.debug('debug msg');
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        body: 'debug msg',
        attributes: expect.objectContaining({
          'logger.name': 'MyService',
          'correlation.id': 'req-456',
        }),
      }),
    );
  });

  test('emits correct severity for each log level', () => {
    configureOtel(mockOtelApis);
    const log = getLogger('Test', 'c');
    log.trace('t');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(mockEmit).toHaveBeenCalledTimes(5);
    expect(mockEmit.mock.calls[0][0].severityNumber).toBe(1);
    expect(mockEmit.mock.calls[1][0].severityNumber).toBe(5);
    expect(mockEmit.mock.calls[2][0].severityNumber).toBe(9);
    expect(mockEmit.mock.calls[3][0].severityNumber).toBe(13);
    expect(mockEmit.mock.calls[4][0].severityNumber).toBe(17);
  });

  test('stdout output continues unchanged after configureOtel', () => {
    configureOtel(mockOtelApis);
    const log = getLogger('Test', 'c');
    log.info('hello');
    expect(mockLogger.info).toHaveBeenCalledWith('[c] hello');
  });

  test('does not emit OTEL log records before configureOtel is called', () => {
    const log = getLogger('Test', 'c');
    log.info('hello');
    expect(mockEmit).not.toHaveBeenCalled();
  });

  test('bare methods do not emit OTEL log records', () => {
    configureOtel(mockOtelApis);
    const log = getLogger('Test', 'c');
    log.infoBare('bare msg');
    expect(mockEmit).not.toHaveBeenCalled();
  });

  test('log method maps to INFO severity', () => {
    configureOtel(mockOtelApis);
    const log = getLogger('Test', 'c');
    log.log('generic msg');
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        severityNumber: 9,
        severityText: 'INFO',
      }),
    );
  });

  test('does nothing when called without arguments', () => {
    configureOtel();
    const log = getLogger('Test', 'c');
    log.info('hello');
    expect(mockEmit).not.toHaveBeenCalled();
  });

  test('does nothing when called with empty object', () => {
    configureOtel({});
    const log = getLogger('Test', 'c');
    log.info('hello');
    expect(mockEmit).not.toHaveBeenCalled();
  });
});

describe('configureOtel with direct loggerProvider', () => {
  beforeEach(() => {
    __resetOtelForTesting();
    vi.clearAllMocks();
  });

  test('uses loggerProvider.getLogger when loggerProvider is provided', () => {
    const providerEmit = vi.fn();
    const providerGetLogger = vi.fn(() => ({ emit: providerEmit }));
    configureOtel({
      SeverityNumber: mockOtelApis.SeverityNumber,
      trace: mockOtelApis.trace,
      context: mockOtelApis.context,
      loggerProvider: { getLogger: providerGetLogger },
    });
    const log = getLogger('Test', 'c');
    log.info('direct provider');
    expect(providerGetLogger).toHaveBeenCalledWith('@lazyapps/logger');
    expect(providerEmit).toHaveBeenCalledOnce();
    expect(mockGetLogger).not.toHaveBeenCalled();
  });

  test('falls back to logs.getLogger when no loggerProvider', () => {
    configureOtel(mockOtelApis);
    expect(mockGetLogger).toHaveBeenCalledWith('@lazyapps/logger');
  });
});

describe('configureOtel graceful degradation', () => {
  beforeEach(() => {
    __resetOtelForTesting();
    vi.clearAllMocks();
  });

  test('does not emit OTEL records when configureOtel has not been called', () => {
    const log = getLogger('Test', 'c');
    log.info('hello');
    expect(mockEmit).not.toHaveBeenCalled();
  });
});
