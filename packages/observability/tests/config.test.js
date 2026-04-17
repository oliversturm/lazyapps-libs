import { describe, test, expect, vi } from 'vitest';

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

const { createConfig, __testing__ } = await import('../config.js');
const { defaults } = __testing__;
const { HttpInstrumentation } =
  await import('@opentelemetry/instrumentation-http');

describe('createConfig', () => {
  test('returns defaults when called with no arguments', () => {
    const config = createConfig();
    expect(config.serviceName).toBe(undefined);
    expect(config.serviceNamespace).toBe(undefined);
    expect(config.traces).toBe(true);
    expect(config.metrics).toBe(true);
    expect(config.logs).toBe(true);
    expect(config.otlp.endpoint).toBe(undefined);
    expect(config.otlp.protocol).toBe(undefined);
    // Secure-by-default: OTLP transport encryption is on unless explicitly
    // opted out. Regression guard for security review #24.
    expect(config.otlp.insecure).toBe(false);
    expect(config.sampler.type).toBe('always_on');
    expect(config.sampler.ratio).toBe(1.0);
  });

  test('merges user config over defaults', () => {
    const config = createConfig({
      serviceName: 'my-service',
      serviceNamespace: 'my-namespace',
      serviceVersion: '1.2.3',
      environment: 'production',
      traces: false,
    });
    expect(config.serviceName).toBe('my-service');
    expect(config.serviceNamespace).toBe('my-namespace');
    expect(config.serviceVersion).toBe('1.2.3');
    expect(config.environment).toBe('production');
    expect(config.traces).toBe(false);
    expect(config.metrics).toBe(true);
    expect(config.logs).toBe(true);
  });

  test('deep merges otlp config', () => {
    const config = createConfig({
      otlp: { endpoint: 'http://otel:4317' },
    });
    expect(config.otlp.endpoint).toBe('http://otel:4317');
    expect(config.otlp.protocol).toBe(undefined);
    expect(config.otlp.insecure).toBe(false);
  });

  test('deep merges sampler config', () => {
    const config = createConfig({
      sampler: { type: 'ratio' },
    });
    expect(config.sampler.type).toBe('ratio');
    expect(config.sampler.ratio).toBe(1.0);
  });

  test('provides default instrumentations when none specified', () => {
    const config = createConfig();
    expect(config.instrumentations).toHaveLength(5);
  });

  test('uses custom instrumentations when provided', () => {
    const custom = [{ name: 'custom' }];
    const config = createConfig({ instrumentations: custom });
    expect(config.instrumentations).toBe(custom);
  });

  test('preserves default serviceName when not overridden', () => {
    const config = createConfig({ traces: false });
    expect(config.serviceName).toBe(undefined);
  });

  test('allows disabling all signals', () => {
    const config = createConfig({
      traces: false,
      metrics: false,
      logs: false,
    });
    expect(config.traces).toBe(false);
    expect(config.metrics).toBe(false);
    expect(config.logs).toBe(false);
  });

  test('overrides otlp protocol while keeping other otlp defaults', () => {
    const config = createConfig({
      otlp: { protocol: 'http/protobuf' },
    });
    expect(config.otlp.protocol).toBe('http/protobuf');
    expect(config.otlp.endpoint).toBe(undefined);
    expect(config.otlp.insecure).toBe(false);
  });

  test('allows opting into insecure OTLP transport', () => {
    const config = createConfig({
      otlp: { insecure: true },
    });
    expect(config.otlp.insecure).toBe(true);
  });

  test('overrides sampler ratio', () => {
    const config = createConfig({
      sampler: { ratio: 0.5 },
    });
    expect(config.sampler.ratio).toBe(0.5);
    expect(config.sampler.type).toBe('always_on');
  });

  test('preserves diagnosticLogLevel default', () => {
    const config = createConfig();
    expect(config.diagnosticLogLevel).toBe('WARN');
  });

  test('overrides diagnosticLogLevel', () => {
    const config = createConfig({ diagnosticLogLevel: 'DEBUG' });
    expect(config.diagnosticLogLevel).toBe('DEBUG');
  });

  test('does not share instrumentation instances between calls', () => {
    const config1 = createConfig();
    const config2 = createConfig();
    expect(config1.instrumentations).not.toBe(config2.instrumentations);
  });

  test('does not mutate the defaults object', () => {
    const originalEndpoint = defaults.otlp.endpoint;
    createConfig({ otlp: { endpoint: 'http://changed:4317' } });
    expect(defaults.otlp.endpoint).toBe(originalEndpoint);
  });

  test('handles empty user config object', () => {
    const config = createConfig({});
    expect(config.serviceName).toBe(undefined);
    expect(config.otlp.endpoint).toBe(undefined);
  });

  test('includes serviceNamespace in defaults', () => {
    const config = createConfig();
    expect(config).toHaveProperty('serviceNamespace');
    expect(config.serviceNamespace).toBe(undefined);
  });

  test('merges serviceNamespace from user config', () => {
    const config = createConfig({ serviceNamespace: 'my-ns' });
    expect(config.serviceNamespace).toBe('my-ns');
  });
});

describe('createInstrumentations', () => {
  const { createInstrumentations } = __testing__;

  test('creates exactly 5 instrumentations', () => {
    const instrumentations = createInstrumentations();
    expect(instrumentations).toHaveLength(5);
  });

  test('creates new instances each call', () => {
    const first = createInstrumentations();
    const second = createInstrumentations();
    expect(first[0]).not.toBe(second[0]);
  });

  test('passes httpInstrumentation options to HttpInstrumentation', () => {
    const opts = { ignoreIncomingRequestHook: () => true };
    createInstrumentations({ httpInstrumentation: opts });
    expect(HttpInstrumentation).toHaveBeenCalledWith(opts);
  });

  test('passes empty object to HttpInstrumentation when no httpInstrumentation config', () => {
    createInstrumentations();
    expect(HttpInstrumentation).toHaveBeenCalledWith({});
  });
});

describe('createConfig with httpInstrumentation', () => {
  test('passes httpInstrumentation config through to instrumentations', () => {
    HttpInstrumentation.mockClear();
    const hook = () => true;
    createConfig({ httpInstrumentation: { ignoreIncomingRequestHook: hook } });
    expect(HttpInstrumentation).toHaveBeenCalledWith({
      ignoreIncomingRequestHook: hook,
    });
  });

  test('does not pass httpInstrumentation when custom instrumentations provided', () => {
    HttpInstrumentation.mockClear();
    const custom = [{ name: 'custom' }];
    createConfig({
      httpInstrumentation: { ignoreIncomingRequestHook: () => true },
      instrumentations: custom,
    });
    expect(HttpInstrumentation).not.toHaveBeenCalled();
  });
});
