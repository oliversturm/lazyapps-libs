import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import {
  LoggerProvider,
  SimpleLogRecordProcessor,
} from '@opentelemetry/sdk-logs';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import { trace, context } from '@opentelemetry/api';
import {
  configureOtel,
  getLogger,
  __resetOtelForTesting,
} from '@lazyapps/logger';

// Custom exporter that captures log records in memory
const createCapturingExporter = () => {
  const records = [];
  return {
    records,
    export: (batch, resultCallback) => {
      records.push(...batch);
      resultCallback({ code: 0 });
    },
    shutdown: () => Promise.resolve(),
  };
};

describe('structured logs integration', () => {
  let loggerProvider;
  let exporter;

  beforeEach(() => {
    exporter = createCapturingExporter();
    loggerProvider = new LoggerProvider({
      processors: [new SimpleLogRecordProcessor(exporter)],
    });
  });

  afterEach(() => {
    __resetOtelForTesting();
    return loggerProvider.shutdown();
  });

  test('logs reach exporter when LoggerProvider is passed directly', () => {
    configureOtel({
      SeverityNumber,
      trace,
      context,
      loggerProvider,
    });

    const logger = getLogger('test-service', 'CORR-123');
    logger.info('Hello structured logs');

    expect(exporter.records.length).toBe(1);
    expect(exporter.records[0].body).toBe('Hello structured logs');
    expect(exporter.records[0].severityNumber).toBe(SeverityNumber.INFO);
    expect(exporter.records[0].severityText).toBe('INFO');
    expect(exporter.records[0].attributes['logger.name']).toBe('test-service');
    expect(exporter.records[0].attributes['correlation.id']).toBe('CORR-123');
  });

  test('multiple log levels emit correct severity', () => {
    configureOtel({
      SeverityNumber,
      trace,
      context,
      loggerProvider,
    });

    const logger = getLogger('svc', 'CID');
    logger.warn('a warning');
    logger.error('an error');

    expect(exporter.records.length).toBe(2);
    expect(exporter.records[0].severityNumber).toBe(SeverityNumber.WARN);
    expect(exporter.records[0].severityText).toBe('WARN');
    expect(exporter.records[1].severityNumber).toBe(SeverityNumber.ERROR);
    expect(exporter.records[1].severityText).toBe('ERROR');
  });

  test('no logs emitted before configureOtel is called', () => {
    const logger = getLogger('svc', 'CID');
    logger.info('should not appear');

    expect(exporter.records.length).toBe(0);
  });

  test('configureOtel without loggerProvider falls back to logs.getLogger', () => {
    // When no loggerProvider is passed, configureOtel uses the global
    // logs.getLogger() — which may be NOOP if no global provider is set.
    // This test just verifies the fallback path doesn't throw.
    configureOtel({
      logs,
      SeverityNumber,
      trace,
      context,
    });

    const logger = getLogger('svc', 'CID');
    // This may or may not produce records depending on global state,
    // but it must not throw.
    logger.info('fallback test');
  });
});
