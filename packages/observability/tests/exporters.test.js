import { describe, test, expect, vi, beforeEach } from 'vitest';

const mockTraceExporter = vi.fn();
const mockMetricExporter = vi.fn();
const mockLogExporter = vi.fn();
const mockMetricReader = vi.fn();

vi.mock('@opentelemetry/exporter-trace-otlp-grpc', () => ({
  OTLPTraceExporter: mockTraceExporter,
}));
vi.mock('@opentelemetry/exporter-metrics-otlp-grpc', () => ({
  OTLPMetricExporter: mockMetricExporter,
}));
vi.mock('@opentelemetry/exporter-logs-otlp-grpc', () => ({
  OTLPLogExporter: mockLogExporter,
}));
vi.mock('@opentelemetry/sdk-metrics', () => ({
  PeriodicExportingMetricReader: mockMetricReader,
}));

const { createExporters, __testing__ } = await import('../exporters.js');

describe('createExporters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('returns all undefined when no endpoint configured', () => {
    const config = {
      traces: true,
      metrics: true,
      logs: true,
      otlp: { endpoint: undefined },
    };
    const exporters = createExporters(config);
    expect(exporters.trace).toBeUndefined();
    expect(exporters.metrics).toBeUndefined();
    expect(exporters.logs).toBeUndefined();
    expect(mockTraceExporter).not.toHaveBeenCalled();
    expect(mockMetricExporter).not.toHaveBeenCalled();
    expect(mockLogExporter).not.toHaveBeenCalled();
  });

  test('returns all undefined when endpoint is empty string', () => {
    const config = {
      traces: true,
      metrics: true,
      logs: true,
      otlp: { endpoint: '' },
    };
    const exporters = createExporters(config);
    expect(exporters.trace).toBeUndefined();
    expect(exporters.metrics).toBeUndefined();
    expect(exporters.logs).toBeUndefined();
  });

  test('creates all exporters when all signals enabled', () => {
    const config = {
      traces: true,
      metrics: true,
      logs: true,
      otlp: { endpoint: 'http://localhost:4317' },
    };
    const exporters = createExporters(config);
    expect(exporters.trace).toBeDefined();
    expect(exporters.metrics).toBeDefined();
    expect(exporters.logs).toBeDefined();
  });

  test('returns undefined trace exporter when traces disabled', () => {
    const config = {
      traces: false,
      metrics: true,
      logs: true,
      otlp: { endpoint: 'http://localhost:4317' },
    };
    const exporters = createExporters(config);
    expect(exporters.trace).toBeUndefined();
  });

  test('returns undefined metric reader when metrics disabled', () => {
    const config = {
      traces: true,
      metrics: false,
      logs: true,
      otlp: { endpoint: 'http://localhost:4317' },
    };
    const exporters = createExporters(config);
    expect(exporters.metrics).toBeUndefined();
  });

  test('returns undefined log exporter when logs disabled', () => {
    const config = {
      traces: true,
      metrics: true,
      logs: false,
      otlp: { endpoint: 'http://localhost:4317' },
    };
    const exporters = createExporters(config);
    expect(exporters.logs).toBeUndefined();
  });

  test('passes correct endpoint to trace exporter', () => {
    const config = {
      traces: true,
      metrics: false,
      logs: false,
      otlp: { endpoint: 'http://otel:4317' },
    };
    createExporters(config);
    expect(mockTraceExporter).toHaveBeenCalledWith({
      url: 'http://otel:4317',
      timeoutMillis: 5000,
    });
  });

  test('passes correct config to metric reader', () => {
    const config = {
      traces: false,
      metrics: true,
      logs: false,
      otlp: { endpoint: 'http://otel:4317' },
    };
    createExporters(config);
    expect(mockMetricReader).toHaveBeenCalledWith(
      expect.objectContaining({
        exportIntervalMillis: 15000,
      }),
    );
  });

  test('returns all undefined when all signals disabled', () => {
    const config = {
      traces: false,
      metrics: false,
      logs: false,
      otlp: { endpoint: 'http://localhost:4317' },
    };
    const exporters = createExporters(config);
    expect(exporters.trace).toBeUndefined();
    expect(exporters.metrics).toBeUndefined();
    expect(exporters.logs).toBeUndefined();
  });

  test('passes correct endpoint to log exporter', () => {
    mockLogExporter.mockClear();
    const config = {
      traces: false,
      metrics: false,
      logs: true,
      otlp: { endpoint: 'http://otel:4317' },
    };
    createExporters(config);
    expect(mockLogExporter).toHaveBeenCalledWith({
      url: 'http://otel:4317',
      timeoutMillis: 5000,
    });
  });

  test('wraps metric exporter in PeriodicExportingMetricReader', () => {
    mockMetricReader.mockClear();
    mockMetricExporter.mockClear();
    const config = {
      traces: false,
      metrics: true,
      logs: false,
      otlp: { endpoint: 'http://otel:4317' },
    };
    createExporters(config);
    expect(mockMetricExporter).toHaveBeenCalled();
    expect(mockMetricReader).toHaveBeenCalledWith(
      expect.objectContaining({
        exporter: expect.anything(),
        exportIntervalMillis: 15000,
      }),
    );
  });
});

describe('createOtlpConfig', () => {
  test('creates config with endpoint and timeout', () => {
    const result = __testing__.createOtlpConfig({
      otlp: { endpoint: 'http://test:4317' },
    });
    expect(result).toEqual({
      url: 'http://test:4317',
      timeoutMillis: 5000,
    });
  });

  test('always sets 5000ms timeout', () => {
    const result = __testing__.createOtlpConfig({
      otlp: { endpoint: 'http://test:4317' },
    });
    expect(result.timeoutMillis).toBe(5000);
  });
});
