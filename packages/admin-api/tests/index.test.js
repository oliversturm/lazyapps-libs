import { describe, test, expect, vi } from 'vitest';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('nanoid', () => ({
  nanoid: vi.fn().mockReturnValue('test-corr-id'),
}));

const { installReplayAdminApi, installReadModelAdminApi } =
  await import('../index.js');

describe('installReplayAdminApi', () => {
  test('registers command processor admin routes', () => {
    const context = {};
    const app = {
      post: vi.fn(),
      get: vi.fn(),
    };

    installReplayAdminApi(context)(app);

    expect(app.post).toHaveBeenCalledWith(
      '/api/admin/startReplay',
      expect.any(Function),
    );
    expect(app.get).toHaveBeenCalledWith(
      '/api/admin/replayStatus/:readModel',
      expect.any(Function),
    );
    expect(app.post).toHaveBeenCalledWith(
      '/api/admin/cancelReplay',
      expect.any(Function),
    );
    expect(app.post).toHaveBeenCalledWith(
      '/api/admin/commandReplayState',
      expect.any(Function),
    );
    expect(app.post).toHaveBeenCalledTimes(3);
    expect(app.get).toHaveBeenCalledTimes(1);
  });
});

describe('installReadModelAdminApi', () => {
  test('registers read model admin routes', () => {
    const context = {};
    const app = {
      post: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
    };

    installReadModelAdminApi(context)(app);

    expect(app.get).toHaveBeenCalledWith('/admin/status', expect.any(Function));
    expect(app.get).toHaveBeenCalledWith(
      '/admin/readmodels',
      expect.any(Function),
    );
    expect(app.post).toHaveBeenCalledWith(
      '/admin/backup/:readModelName',
      expect.any(Function),
    );
    expect(app.get).toHaveBeenCalledWith(
      '/admin/backups/:readModelName',
      expect.any(Function),
    );
    expect(app.delete).toHaveBeenCalledWith(
      '/admin/backup/:backupId',
      expect.any(Function),
    );
    expect(app.post).toHaveBeenCalledWith(
      '/admin/replay/:readModelName/prepare',
      expect.any(Function),
    );
    expect(app.get).toHaveBeenCalledWith(
      '/admin/replay/:readModelName/status',
      expect.any(Function),
    );
    expect(app.post).toHaveBeenCalledTimes(2);
    expect(app.get).toHaveBeenCalledTimes(4);
    expect(app.delete).toHaveBeenCalledTimes(1);
  });
});
