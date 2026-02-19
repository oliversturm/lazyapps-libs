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

const {
  mockStartCommandProcessor,
  mockStartReadModels,
  mockStartSvelteKit,
  mockStartAdmin,
} = vi.hoisted(() => ({
  mockStartCommandProcessor: vi.fn().mockResolvedValue({ close: vi.fn() }),
  mockStartReadModels: vi.fn().mockResolvedValue({ close: vi.fn() }),
  mockStartSvelteKit: vi.fn(),
  mockStartAdmin: vi.fn().mockResolvedValue({ close: vi.fn() }),
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

vi.mock('../admin.js', () => ({
  startAdmin: mockStartAdmin,
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

  test('starts admin when admin config provided', async () => {
    const admin = { port: 3005, readModels: {} };
    const correlation = { serviceId: 'TEST' };
    start({ correlation, admin });
    await vi.waitFor(() => {
      expect(mockStartAdmin).toHaveBeenCalledWith(correlation, admin);
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

  test('does not start admin when not configured', async () => {
    start({ correlation: { serviceId: 'TEST' } });
    // Give dynamic import time to resolve if it was going to
    await vi.waitFor(
      () => {
        expect(mockStartAdmin).not.toHaveBeenCalled();
      },
      { timeout: 50 },
    );
  });

  test('starts all subsystems when fully configured', async () => {
    const listener = vi.fn().mockResolvedValue({ close: vi.fn() });
    start({
      correlation: { serviceId: 'TEST' },
      commands: { receiver: vi.fn() },
      readModels: { listener: vi.fn() },
      changeNotifier: { listener },
      svelte: { port: 5173 },
      admin: { port: 3005, readModels: {} },
    });
    await vi.waitFor(() => {
      expect(mockStartSvelteKit).toHaveBeenCalledOnce();
      expect(mockStartAdmin).toHaveBeenCalledOnce();
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
      'bootstrap.admin': false,
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
      'bootstrap.admin': false,
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

  test('span attributes include admin when admin is configured', () => {
    start({
      correlation: { serviceId: 'TEST' },
      admin: { port: 3005, readModels: {} },
    });
    const spanArgs = mockStartSpan.mock.calls[0][1];
    expect(spanArgs.attributes['bootstrap.admin']).toBe(true);
  });
});
