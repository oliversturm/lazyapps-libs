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
  // The default mock returns no active span — so existing tests that don't
  // care about correlation see the same emit shape as before.
  trace: { getSpan: vi.fn().mockReturnValue(undefined) },
  context: { active: vi.fn().mockReturnValue({}) },
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

describe('configureOtel log-to-trace correlation', () => {
  beforeEach(() => {
    __resetOtelForTesting();
    vi.clearAllMocks();
  });

  test('attaches traceId/spanId from active span to emitted log record', () => {
    const fakeSpanCtx = {
      traceId: '0123456789abcdef0123456789abcdef',
      spanId: '0123456789abcdef',
      traceFlags: 1,
    };
    const fakeSpan = { spanContext: vi.fn().mockReturnValue(fakeSpanCtx) };
    const fakeContext = Symbol('active-context');
    const trace = { getSpan: vi.fn().mockReturnValue(fakeSpan) };
    const context = { active: vi.fn().mockReturnValue(fakeContext) };

    configureOtel({
      logs: mockOtelApis.logs,
      SeverityNumber: mockOtelApis.SeverityNumber,
      trace,
      context,
    });
    const log = getLogger('Test', 'corr-1');
    log.info('hello');

    expect(context.active).toHaveBeenCalled();
    expect(trace.getSpan).toHaveBeenCalledWith(fakeContext);
    expect(mockEmit).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: fakeSpanCtx.traceId,
        spanId: fakeSpanCtx.spanId,
      }),
    );
    // traceId/spanId belong on the record root per OTel logs data model,
    // not in attributes — backends pivot on the top-level fields.
    const attrs = mockEmit.mock.calls[0][0].attributes;
    expect(attrs.traceId).toBeUndefined();
    expect(attrs.spanId).toBeUndefined();
  });

  test('omits traceId/spanId when no span is active', () => {
    const trace = { getSpan: vi.fn().mockReturnValue(undefined) };
    const context = { active: vi.fn().mockReturnValue({}) };

    configureOtel({
      logs: mockOtelApis.logs,
      SeverityNumber: mockOtelApis.SeverityNumber,
      trace,
      context,
    });
    const log = getLogger('Test', 'corr-1');
    log.info('hello');

    const record = mockEmit.mock.calls[0][0];
    expect(record.traceId).toBeUndefined();
    expect(record.spanId).toBeUndefined();
  });

  test('omits traceId/spanId when trace and context APIs are not configured', () => {
    configureOtel({
      logs: mockOtelApis.logs,
      SeverityNumber: mockOtelApis.SeverityNumber,
      // no trace, no context
    });
    const log = getLogger('Test', 'corr-1');
    log.info('hello');

    const record = mockEmit.mock.calls[0][0];
    expect(record.traceId).toBeUndefined();
    expect(record.spanId).toBeUndefined();
  });

  test('skips correlation when span.spanContext returns no traceId', () => {
    // Defensive: an unsampled or invalid span may produce an empty context.
    const fakeSpan = {
      spanContext: vi.fn().mockReturnValue({ traceId: '', spanId: '' }),
    };
    const trace = { getSpan: vi.fn().mockReturnValue(fakeSpan) };
    const context = { active: vi.fn().mockReturnValue({}) };

    configureOtel({
      logs: mockOtelApis.logs,
      SeverityNumber: mockOtelApis.SeverityNumber,
      trace,
      context,
    });
    const log = getLogger('Test', 'corr-1');
    log.info('hello');

    const record = mockEmit.mock.calls[0][0];
    expect(record.traceId).toBeUndefined();
    expect(record.spanId).toBeUndefined();
  });
});
