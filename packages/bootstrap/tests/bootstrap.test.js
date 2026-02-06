import { describe, test, expect, vi, beforeEach } from 'vitest';

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
} = vi.hoisted(() => ({
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

  test('starts svelte when svelte config provided', () => {
    const svelte = { port: 5173 };
    const correlation = { serviceId: 'TEST' };
    start({ correlation, svelte });
    expect(mockStartSvelteKit).toHaveBeenCalledWith(correlation, svelte);
  });

  test('does not start command processor when not configured', () => {
    start({ correlation: { serviceId: 'TEST' } });
    expect(mockStartCommandProcessor).not.toHaveBeenCalled();
  });

  test('does not start read models when not configured', () => {
    start({ correlation: { serviceId: 'TEST' } });
    expect(mockStartReadModels).not.toHaveBeenCalled();
  });

  test('starts all subsystems when fully configured', () => {
    const listener = vi.fn().mockResolvedValue({ close: vi.fn() });
    start({
      correlation: { serviceId: 'TEST' },
      commands: { receiver: vi.fn() },
      readModels: { listener: vi.fn() },
      changeNotifier: { listener },
      svelte: { port: 5173 },
    });
    expect(mockStartCommandProcessor).toHaveBeenCalledOnce();
    expect(mockStartReadModels).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledOnce();
    expect(mockStartSvelteKit).toHaveBeenCalledOnce();
  });
});
