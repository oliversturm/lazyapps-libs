import { describe, test, expect, vi } from 'vitest';

const mockStart = vi.fn();
const mockNodeSDK = vi.fn(function () {
  this.start = mockStart;
});

vi.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: mockNodeSDK,
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

const { initialize } = await import('../index.js');

describe('initialize', () => {
  test('creates and starts NodeSDK', () => {
    initialize({ serviceName: 'test-service' });
    expect(mockNodeSDK).toHaveBeenCalled();
    expect(mockStart).toHaveBeenCalled();
  });

  test('passes resource to NodeSDK', () => {
    mockNodeSDK.mockClear();
    initialize({ serviceName: 'test-service' });
    const sdkConfig = mockNodeSDK.mock.calls[0][0];
    expect(sdkConfig.resource.attributes['service.name']).toBe('test-service');
  });

  test('passes instrumentations to NodeSDK', () => {
    mockNodeSDK.mockClear();
    initialize({ serviceName: 'test-service' });
    const sdkConfig = mockNodeSDK.mock.calls[0][0];
    expect(sdkConfig.instrumentations).toHaveLength(5);
  });

  test('passes exporters to NodeSDK', () => {
    mockNodeSDK.mockClear();
    initialize({ serviceName: 'test-service' });
    const sdkConfig = mockNodeSDK.mock.calls[0][0];
    expect(sdkConfig.traceExporter).toBeDefined();
    expect(sdkConfig.metricReader).toBeDefined();
    expect(sdkConfig.logRecordExporter).toBeDefined();
  });

  test('returns the SDK instance', () => {
    const sdk = initialize({ serviceName: 'test-service' });
    expect(sdk).toBeInstanceOf(mockNodeSDK);
    expect(sdk.start).toBeDefined();
  });

  test('uses default config when no service name provided', () => {
    mockNodeSDK.mockClear();
    initialize();
    const sdkConfig = mockNodeSDK.mock.calls[0][0];
    expect(sdkConfig.resource.attributes['service.name']).toBe(
      'unknown-service',
    );
  });

  test('passes undefined exporters when signals disabled', () => {
    mockNodeSDK.mockClear();
    initialize({
      serviceName: 'test-service',
      traces: false,
      metrics: false,
      logs: false,
    });
    const sdkConfig = mockNodeSDK.mock.calls[0][0];
    expect(sdkConfig.traceExporter).toBeUndefined();
    expect(sdkConfig.metricReader).toBeUndefined();
    expect(sdkConfig.logRecordExporter).toBeUndefined();
  });

  test('starts SDK exactly once per call', () => {
    mockStart.mockClear();
    initialize({ serviceName: 'test-service' });
    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  test('creates separate SDK instances for each call', () => {
    mockNodeSDK.mockClear();
    initialize({ serviceName: 'service-a' });
    initialize({ serviceName: 'service-b' });
    expect(mockNodeSDK).toHaveBeenCalledTimes(2);
  });
});
