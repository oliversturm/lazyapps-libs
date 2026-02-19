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
  context: { active: vi.fn() },
}));

vi.mock('@lazyapps/logger', () => {
  const getLogger = vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  });
  return { getLogger };
});

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

  test('starts command processor when commands config provided', () => {
    const commands = { receiver: vi.fn() };
    const correlation = { serviceId: 'TEST' };
    start({ correlation, commands });
    expect(mockStartCommandProcessor).toHaveBeenCalledWith(
      correlation,
      commands,
    );
  });

  test('starts read models when readModels config provided', () => {
    const readModels = { listener: vi.fn() };
    const correlation = { serviceId: 'TEST' };
    start({ correlation, readModels });
    expect(mockStartReadModels).toHaveBeenCalledWith(correlation, readModels);
  });

  test('starts change notifier when changeNotifier config provided', () => {
    const listener = vi.fn().mockResolvedValue({ close: vi.fn() });
    const changeNotifier = { listener };
    const correlation = { serviceId: 'TEST' };
    start({ correlation, changeNotifier });
    expect(listener).toHaveBeenCalledWith(correlation);
  });

  test('starts svelte when svelte config provided', async () => {
    const svelte = { port: 5173 };
    const correlation = { serviceId: 'TEST' };
    start({ correlation, svelte });
    await vi.waitFor(() => {
      expect(mockStartSvelteKit).toHaveBeenCalledWith(correlation, svelte);
    });
  });

  test('does not start command processor when not configured', () => {
    start({ correlation: { serviceId: 'TEST' } });
    expect(mockStartCommandProcessor).not.toHaveBeenCalled();
  });

  test('does not start read models when not configured', () => {
    start({ correlation: { serviceId: 'TEST' } });
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

describe('encryption integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('wraps command eventStore and eventBus when encryption provided', async () => {
    const wrappedEventStore = vi.fn();
    const wrappedEventBus = vi.fn();
    const enc = {
      wrapEventStore: vi.fn().mockReturnValue(wrappedEventStore),
      wrapEventBus: vi.fn().mockReturnValue(wrappedEventBus),
      createProjectionDecryptor: vi.fn(),
      wrapStorage: vi.fn(),
    };
    const commands = {
      receiver: vi.fn(),
      eventStore: vi.fn(),
      eventBus: vi.fn(),
    };

    start({
      correlation: { serviceId: 'TEST' },
      encryption: Promise.resolve(enc),
      commands,
    });

    await vi.waitFor(() => {
      expect(mockStartCommandProcessor).toHaveBeenCalledOnce();
    });

    expect(enc.wrapEventStore).toHaveBeenCalledWith(commands.eventStore);
    expect(enc.wrapEventBus).toHaveBeenCalledWith(commands.eventBus);
    const calledWith = mockStartCommandProcessor.mock.calls[0][1];
    expect(calledWith.eventStore).toBe(wrappedEventStore);
    expect(calledWith.eventBus).toBe(wrappedEventBus);
    expect(calledWith.receiver).toBe(commands.receiver);
  });

  test('wraps readModels storage and injects decryptor when encryption provided', async () => {
    const mockDecryptor = vi.fn();
    const wrappedStorage = vi.fn();
    const enc = {
      wrapEventStore: vi.fn(),
      wrapEventBus: vi.fn(),
      createProjectionDecryptor: vi.fn().mockReturnValue(mockDecryptor),
      wrapStorage: vi.fn().mockReturnValue(wrappedStorage),
    };
    const readModels = {
      listener: vi.fn(),
      storage: vi.fn(),
      role: 'customer-rm',
    };

    start({
      correlation: { serviceId: 'TEST' },
      encryption: Promise.resolve(enc),
      readModels,
    });

    await vi.waitFor(() => {
      expect(mockStartReadModels).toHaveBeenCalledOnce();
    });

    expect(enc.createProjectionDecryptor).toHaveBeenCalledWith('customer-rm');
    expect(enc.wrapStorage).toHaveBeenCalledWith(readModels.storage);
    const calledWith = mockStartReadModels.mock.calls[0][1];
    expect(calledWith.encryptionDecryptor).toBe(mockDecryptor);
    expect(calledWith.storage).toBe(wrappedStorage);
  });

  test('uses default role "service" when readModels.role is not set', async () => {
    const enc = {
      wrapEventStore: vi.fn(),
      wrapEventBus: vi.fn(),
      createProjectionDecryptor: vi.fn(),
      wrapStorage: vi.fn(),
    };

    start({
      correlation: { serviceId: 'TEST' },
      encryption: Promise.resolve(enc),
      readModels: { listener: vi.fn(), storage: vi.fn() },
    });

    await vi.waitFor(() => {
      expect(mockStartReadModels).toHaveBeenCalledOnce();
    });

    expect(enc.createProjectionDecryptor).toHaveBeenCalledWith('service');
  });

  test('does not wrap when encryption is not provided', () => {
    const commands = { receiver: vi.fn(), eventStore: vi.fn() };
    start({
      correlation: { serviceId: 'TEST' },
      commands,
    });
    expect(mockStartCommandProcessor).toHaveBeenCalledWith(
      { serviceId: 'TEST' },
      commands,
    );
  });

  test('accepts a non-promise encryption object', async () => {
    const enc = {
      wrapEventStore: vi.fn().mockReturnValue(vi.fn()),
      wrapEventBus: vi.fn().mockReturnValue(vi.fn()),
      createProjectionDecryptor: vi.fn(),
      wrapStorage: vi.fn(),
    };

    start({
      correlation: { serviceId: 'TEST' },
      encryption: enc,
      commands: { receiver: vi.fn(), eventStore: vi.fn(), eventBus: vi.fn() },
    });

    await vi.waitFor(() => {
      expect(mockStartCommandProcessor).toHaveBeenCalledOnce();
    });

    expect(enc.wrapEventStore).toHaveBeenCalledOnce();
  });
});

describe('observability integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('creates bootstrap.start span on start', () => {
    start({ correlation: { serviceId: 'TEST' } });
    expect(mockStartSpan).toHaveBeenCalledWith(
      'lazyapps.bootstrap.start',
      expect.any(Object),
    );
  });

  test('ends the start span', () => {
    start({ correlation: { serviceId: 'TEST' } });
    expect(mockSpan.end).toHaveBeenCalledOnce();
  });

  test('span attributes reflect configured components', () => {
    const listener = vi.fn().mockResolvedValue({ close: vi.fn() });
    start({
      correlation: { serviceId: 'TEST' },
      commands: { receiver: vi.fn() },
      readModels: { listener: vi.fn() },
      changeNotifier: { listener },
    });
    const spanArgs = mockStartSpan.mock.calls[0][1];
    expect(spanArgs.attributes).toEqual({
      'bootstrap.commands': true,
      'bootstrap.readModels': true,
      'bootstrap.changeNotifier': true,
      'bootstrap.svelte': false,
    });
  });

  test('span attributes are all false when nothing configured', () => {
    start({ correlation: { serviceId: 'TEST' } });
    const spanArgs = mockStartSpan.mock.calls[0][1];
    expect(spanArgs.attributes).toEqual({
      'bootstrap.commands': false,
      'bootstrap.readModels': false,
      'bootstrap.changeNotifier': false,
      'bootstrap.svelte': false,
    });
  });

  test('span is created and ended even when only svelte is configured', () => {
    start({
      correlation: { serviceId: 'TEST' },
      svelte: { port: 5173 },
    });
    expect(mockStartSpan).toHaveBeenCalledOnce();
    expect(mockSpan.end).toHaveBeenCalledOnce();
    const spanArgs = mockStartSpan.mock.calls[0][1];
    expect(spanArgs.attributes['bootstrap.svelte']).toBe(true);
  });
});
