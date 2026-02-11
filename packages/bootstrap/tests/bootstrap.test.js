import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockSpan, mockStartSpan, mockGetTracer } = vi.hoisted(() => {
  const mockSpan = { end: vi.fn() };
  const mockStartSpan = vi.fn(() => mockSpan);
  const mockGetTracer = vi.fn(() => ({ startSpan: mockStartSpan }));
  return { mockSpan, mockStartSpan, mockGetTracer };
});

vi.mock('@opentelemetry/api', () => ({
  trace: {
    getTracer: mockGetTracer,
  },
}));

const mockConfigureOtel = vi.hoisted(() => vi.fn().mockResolvedValue());
const mockInitialize = vi.hoisted(() => vi.fn());

vi.mock('@lazyapps/logger', () => {
  const getLogger = vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  });
  return { getLogger, configureOtel: mockConfigureOtel };
});

vi.mock('@lazyapps/observability', () => ({
  initialize: mockInitialize,
}));

const { mockStartCommandProcessor, mockStartReadModels, mockStartSvelteKit } =
  vi.hoisted(() => ({
    mockStartCommandProcessor: vi.fn().mockResolvedValue({ close: vi.fn() }),
    mockStartReadModels: vi.fn().mockResolvedValue({ close: vi.fn() }),
    mockStartSvelteKit: vi.fn(),
  }));

vi.mock('@lazyapps/command-processor', () => ({
  startCommandProcessor: mockStartCommandProcessor,
}));

vi.mock('@lazyapps/readmodels', () => ({
  startReadModels: mockStartReadModels,
}));

vi.mock('../svelte.js', () => ({
  startSvelteKit: mockStartSvelteKit,
}));

const { start } = await import('../index.js');

describe('start', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('starts command processor when commands config provided', async () => {
    const commands = { receiver: vi.fn() };
    const correlation = { serviceId: 'TEST' };
    start({ correlation, commands });
    await vi.waitFor(() => {
      expect(mockStartCommandProcessor).toHaveBeenCalledWith(
        correlation,
        commands,
      );
    });
  });

  test('starts read models when readModels config provided', async () => {
    const readModels = { listener: vi.fn() };
    const correlation = { serviceId: 'TEST' };
    start({ correlation, readModels });
    await vi.waitFor(() => {
      expect(mockStartReadModels).toHaveBeenCalledWith(correlation, readModels);
    });
  });

  test('starts change notifier when changeNotifier config provided', async () => {
    const listener = vi.fn().mockResolvedValue({ close: vi.fn() });
    const changeNotifier = { listener };
    const correlation = { serviceId: 'TEST' };
    start({ correlation, changeNotifier });
    await vi.waitFor(() => {
      expect(listener).toHaveBeenCalledWith(correlation);
    });
  });

  test('starts svelte when svelte config provided', async () => {
    const svelte = { port: 5173 };
    const correlation = { serviceId: 'TEST' };
    start({ correlation, svelte });
    await vi.waitFor(() => {
      expect(mockStartSvelteKit).toHaveBeenCalledWith(correlation, svelte);
    });
  });

  test('does not start command processor when not configured', async () => {
    start({ correlation: { serviceId: 'TEST' } });
    await vi.waitFor(() => {
      expect(mockStartSpan).toHaveBeenCalled();
    });
    expect(mockStartCommandProcessor).not.toHaveBeenCalled();
  });

  test('does not start read models when not configured', async () => {
    start({ correlation: { serviceId: 'TEST' } });
    await vi.waitFor(() => {
      expect(mockStartSpan).toHaveBeenCalled();
    });
    expect(mockStartReadModels).not.toHaveBeenCalled();
  });

  test('starts all subsystems when fully configured', async () => {
    const listener = vi.fn().mockResolvedValue({ close: vi.fn() });
    start({
      correlation: { serviceId: 'TEST' },
      commands: { receiver: vi.fn() },
      readModels: { listener: vi.fn() },
      changeNotifier: { listener },
      svelte: { port: 5173 },
    });
    await vi.waitFor(() => {
      expect(mockStartSvelteKit).toHaveBeenCalledOnce();
    });
    expect(mockStartCommandProcessor).toHaveBeenCalledOnce();
    expect(mockStartReadModels).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledOnce();
  });
});

describe('observability integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('creates bootstrap.start span on start', async () => {
    start({ correlation: { serviceId: 'TEST' } });
    await vi.waitFor(() => {
      expect(mockStartSpan).toHaveBeenCalledWith(
        'lazyapps.bootstrap.start',
        expect.any(Object),
      );
    });
  });

  test('ends the start span', async () => {
    start({ correlation: { serviceId: 'TEST' } });
    await vi.waitFor(() => {
      expect(mockSpan.end).toHaveBeenCalledOnce();
    });
  });

  test('span attributes reflect configured components', async () => {
    const listener = vi.fn().mockResolvedValue({ close: vi.fn() });
    start({
      correlation: { serviceId: 'TEST' },
      commands: { receiver: vi.fn() },
      readModels: { listener: vi.fn() },
      changeNotifier: { listener },
    });
    await vi.waitFor(() => {
      expect(mockStartSpan).toHaveBeenCalled();
    });
    const spanArgs = mockStartSpan.mock.calls[0][1];
    expect(spanArgs.attributes).toEqual({
      'bootstrap.observability': false,
      'bootstrap.commands': true,
      'bootstrap.readModels': true,
      'bootstrap.changeNotifier': true,
      'bootstrap.svelte': false,
    });
  });

  test('span attributes are all false when nothing configured', async () => {
    start({ correlation: { serviceId: 'TEST' } });
    await vi.waitFor(() => {
      expect(mockStartSpan).toHaveBeenCalled();
    });
    const spanArgs = mockStartSpan.mock.calls[0][1];
    expect(spanArgs.attributes).toEqual({
      'bootstrap.observability': false,
      'bootstrap.commands': false,
      'bootstrap.readModels': false,
      'bootstrap.changeNotifier': false,
      'bootstrap.svelte': false,
    });
  });

  test('span is created and ended even when only svelte is configured', async () => {
    start({
      correlation: { serviceId: 'TEST' },
      svelte: { port: 5173 },
    });
    await vi.waitFor(() => {
      expect(mockStartSpan).toHaveBeenCalledOnce();
    });
    expect(mockSpan.end).toHaveBeenCalledOnce();
    const spanArgs = mockStartSpan.mock.calls[0][1];
    expect(spanArgs.attributes['bootstrap.svelte']).toBe(true);
  });
});

describe('bootstrap-managed observability init', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('calls initialize when observability config provided', async () => {
    const observability = {
      serviceName: 'test-service',
      otlp: { endpoint: 'http://localhost:4317' },
    };
    start({ correlation: { serviceId: 'TEST' }, observability });
    await vi.waitFor(() => {
      expect(mockInitialize).toHaveBeenCalledWith(observability);
    });
  });

  test('calls configureOtel after initialize', async () => {
    const observability = { serviceName: 'test-service' };
    start({ correlation: { serviceId: 'TEST' }, observability });
    await vi.waitFor(() => {
      expect(mockConfigureOtel).toHaveBeenCalledOnce();
    });
  });

  test('does not call initialize when observability not configured', async () => {
    start({ correlation: { serviceId: 'TEST' } });
    await vi.waitFor(() => {
      expect(mockStartSpan).toHaveBeenCalled();
    });
    expect(mockInitialize).not.toHaveBeenCalled();
    expect(mockConfigureOtel).not.toHaveBeenCalled();
  });

  test('starts components after observability init completes', async () => {
    const commands = { receiver: vi.fn() };
    const observability = { serviceName: 'test-service' };
    start({
      correlation: { serviceId: 'TEST' },
      observability,
      commands,
    });
    await vi.waitFor(() => {
      expect(mockStartCommandProcessor).toHaveBeenCalled();
    });
    expect(mockInitialize).toHaveBeenCalledBefore(mockStartCommandProcessor);
  });

  test('span attributes include observability true when configured', async () => {
    start({
      correlation: { serviceId: 'TEST' },
      observability: { serviceName: 'test-service' },
    });
    await vi.waitFor(() => {
      expect(mockStartSpan).toHaveBeenCalled();
    });
    const spanArgs = mockStartSpan.mock.calls[0][1];
    expect(spanArgs.attributes['bootstrap.observability']).toBe(true);
  });
});
