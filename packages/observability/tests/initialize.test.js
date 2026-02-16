import { describe, test, expect, vi, beforeEach } from 'vitest';

const mockStart = vi.fn();
const mockNodeSDK = vi.fn(function () {
  this.start = mockStart;
});

const mockSetGlobalLoggerProvider = vi.fn();
const mockLoggerProvider = vi.fn(function () {
  this.shutdown = vi.fn(() => Promise.resolve());
});
const mockBatchLogRecordProcessor = vi.fn();

vi.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: mockNodeSDK,
}));
vi.mock('@opentelemetry/api-logs', () => ({
  logs: { setGlobalLoggerProvider: mockSetGlobalLoggerProvider },
}));
vi.mock('@opentelemetry/sdk-logs', () => ({
  LoggerProvider: mockLoggerProvider,
  BatchLogRecordProcessor: mockBatchLogRecordProcessor,
}));
vi.mock('@opentelemetry/resources', () => ({
  resourceFromAttributes: vi.fn((attrs) => ({ attributes: attrs })),
}));
vi.mock('@opentelemetry/semantic-conventions', () => ({
  ATTR_SERVICE_NAME: 'service.name',
  ATTR_SERVICE_VERSION: 'service.version',
}));
vi.mock('@opentelemetry/exporter-trace-otlp-grpc', () => ({
  OTLPTraceExporter: vi.fn(),
}));
vi.mock('@opentelemetry/exporter-metrics-otlp-grpc', () => ({
  OTLPMetricExporter: vi.fn(),
}));
vi.mock('@opentelemetry/exporter-logs-otlp-grpc', () => ({
  OTLPLogExporter: vi.fn(),
}));
vi.mock('@opentelemetry/sdk-metrics', () => ({
  PeriodicExportingMetricReader: vi.fn(),
}));
vi.mock('@opentelemetry/instrumentation-http', () => ({
  HttpInstrumentation: vi.fn(),
}));
vi.mock('@opentelemetry/instrumentation-express', () => ({
  ExpressInstrumentation: vi.fn(),
}));
vi.mock('@opentelemetry/instrumentation-mongodb', () => ({
  MongoDBInstrumentation: vi.fn(),
}));
vi.mock('@opentelemetry/instrumentation-amqplib', () => ({
  AmqplibInstrumentation: vi.fn(),
}));
vi.mock('@opentelemetry/instrumentation-socket.io', () => ({
  SocketIoInstrumentation: vi.fn(),
}));

const { initialize, isInitialized, __resetForTesting } =
  await import('../index.js');

describe('initialize', () => {
  beforeEach(() => {
    __resetForTesting();
    vi.clearAllMocks();
  });

  test('creates and starts NodeSDK', () => {
    initialize({
      serviceName: 'test-service',
      otlp: { endpoint: 'http://localhost:4317' },
    });
    expect(mockNodeSDK).toHaveBeenCalled();
    expect(mockStart).toHaveBeenCalled();
  });

  test('passes resource to NodeSDK when serviceName provided', () => {
    initialize({
      serviceName: 'test-service',
      otlp: { endpoint: 'http://localhost:4317' },
    });
    const sdkConfig = mockNodeSDK.mock.calls[0][0];
    expect(sdkConfig.resource.attributes['service.name']).toBe('test-service');
  });

  test('does not pass resource to NodeSDK when no attributes set', () => {
    initialize({ otlp: { endpoint: 'http://localhost:4317' } });
    const sdkConfig = mockNodeSDK.mock.calls[0][0];
    expect(sdkConfig.resource).toBeUndefined();
  });

  test('passes instrumentations to NodeSDK', () => {
    initialize({
      serviceName: 'test-service',
      otlp: { endpoint: 'http://localhost:4317' },
    });
    const sdkConfig = mockNodeSDK.mock.calls[0][0];
    expect(sdkConfig.instrumentations).toHaveLength(5);
  });

  test('passes trace and metric exporters to NodeSDK when endpoint set', () => {
    initialize({
      serviceName: 'test-service',
      otlp: { endpoint: 'http://localhost:4317' },
    });
    const sdkConfig = mockNodeSDK.mock.calls[0][0];
    expect(sdkConfig.traceExporter).toBeDefined();
    expect(sdkConfig.metricReader).toBeDefined();
  });

  test('does not pass exporters to NodeSDK when no endpoint set', () => {
    initialize({ serviceName: 'test-service' });
    const sdkConfig = mockNodeSDK.mock.calls[0][0];
    expect(sdkConfig.traceExporter).toBeUndefined();
    expect(sdkConfig.metricReader).toBeUndefined();
  });

  test('registers global LoggerProvider when logs enabled and endpoint set', () => {
    initialize({
      serviceName: 'test-service',
      otlp: { endpoint: 'http://localhost:4317' },
    });
    expect(mockLoggerProvider).toHaveBeenCalled();
    expect(mockBatchLogRecordProcessor).toHaveBeenCalled();
    expect(mockSetGlobalLoggerProvider).toHaveBeenCalled();
  });

  test('does not register LoggerProvider when no endpoint set', () => {
    initialize({ serviceName: 'test-service' });
    expect(mockLoggerProvider).not.toHaveBeenCalled();
    expect(mockSetGlobalLoggerProvider).not.toHaveBeenCalled();
  });

  test('returns the SDK instance', () => {
    const sdk = initialize({ serviceName: 'test-service' });
    expect(sdk).toBeInstanceOf(mockNodeSDK);
    expect(sdk.start).toBeDefined();
  });

  test('starts SDK without exporters when no endpoint configured', () => {
    initialize();
    const sdkConfig = mockNodeSDK.mock.calls[0][0];
    expect(sdkConfig.instrumentations).toHaveLength(5);
    expect(sdkConfig.resource).toBeUndefined();
    expect(sdkConfig.traceExporter).toBeUndefined();
    expect(sdkConfig.metricReader).toBeUndefined();
    expect(mockStart).toHaveBeenCalled();
  });

  test('does not pass exporters when signals disabled', () => {
    initialize({
      serviceName: 'test-service',
      otlp: { endpoint: 'http://localhost:4317' },
      traces: false,
      metrics: false,
      logs: false,
    });
    const sdkConfig = mockNodeSDK.mock.calls[0][0];
    expect(sdkConfig.traceExporter).toBeUndefined();
    expect(sdkConfig.metricReader).toBeUndefined();
  });

  test('does not register LoggerProvider when logs disabled', () => {
    initialize({
      serviceName: 'test-service',
      otlp: { endpoint: 'http://localhost:4317' },
      logs: false,
    });
    expect(mockLoggerProvider).not.toHaveBeenCalled();
    expect(mockSetGlobalLoggerProvider).not.toHaveBeenCalled();
  });

  test('starts SDK exactly once per call', () => {
    initialize({ serviceName: 'test-service' });
    expect(mockStart).toHaveBeenCalledTimes(1);
  });
});

describe('double-init guard', () => {
  beforeEach(() => {
    __resetForTesting();
    vi.clearAllMocks();
  });

  test('skips initialization on second call', () => {
    initialize({ serviceName: 'service-a' });
    initialize({ serviceName: 'service-b' });
    expect(mockNodeSDK).toHaveBeenCalledTimes(1);
  });

  test('returns undefined on second call', () => {
    const first = initialize({ serviceName: 'service-a' });
    const second = initialize({ serviceName: 'service-b' });
    expect(first).toBeInstanceOf(mockNodeSDK);
    expect(second).toBeUndefined();
  });

  test('isInitialized returns false before initialize', () => {
    expect(isInitialized()).toBe(false);
  });

  test('isInitialized returns true after initialize', () => {
    initialize({ serviceName: 'test-service' });
    expect(isInitialized()).toBe(true);
  });

  test('__resetForTesting resets the guard', () => {
    initialize({ serviceName: 'test-service' });
    expect(isInitialized()).toBe(true);
    __resetForTesting();
    expect(isInitialized()).toBe(false);
    initialize({ serviceName: 'test-service' });
    expect(mockNodeSDK).toHaveBeenCalledTimes(2);
  });
});
