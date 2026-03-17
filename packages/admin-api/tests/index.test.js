import { describe, test, expect, vi } from 'vitest';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('nanoid', () => ({
  nanoid: vi.fn().mockReturnValue('test-corr-id'),
}));

const { installReadModelStatusApi, installAdminRoutes, createSseClient } =
  await import('../index.js');

describe('installReadModelStatusApi (PRESERVED)', () => {
  test('registers RM service status routes', () => {
    const context = {
      readModels: { items: {} },
      projectionHandler: {
        getReadModelReplayStates: vi.fn().mockReturnValue({}),
      },
    };
    const app = {
      get: vi.fn(),
    };

    installReadModelStatusApi(context)(app);

    expect(app.get).toHaveBeenCalledWith('/admin/status', expect.any(Function));
    expect(app.get).toHaveBeenCalledWith(
      '/admin/readmodel',
      expect.any(Function),
    );
    expect(app.get).toHaveBeenCalledWith(
      '/admin/replay/:endpointName/:readModelName/status',
      expect.any(Function),
    );
    expect(app.get).toHaveBeenCalledTimes(3);
  });
});

describe('re-exported modules', () => {
  test('installAdminRoutes is exported', () => {
    expect(typeof installAdminRoutes).toBe('function');
  });

  test('createSseClient is exported', () => {
    expect(typeof createSseClient).toBe('function');
  });
});
