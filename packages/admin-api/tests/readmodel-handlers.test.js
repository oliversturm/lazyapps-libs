import { describe, test, expect, vi, beforeEach } from 'vitest';

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

const {
  statusHandler,
  readModelsHandler,
  createBackupHandler,
  listBackupsHandler,
  deleteBackupHandler,
  prepareReplayHandler,
  replayReadModelStatusHandler,
  resetReplayStateHandler,
  __testing__,
} = await import('../readmodel-handlers.js');

const mockReq = (body = {}, params = {}) => ({
  body,
  params,
});

const mockRes = () => {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.sendStatus = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  return res;
};

describe('detectSharedCollections', () => {
  test('detects shared collections between read models', () => {
    const readModels = {
      items: { collections: ['items', 'tags'] },
      orders: { collections: ['items', 'orderLines'] },
      stats: { collections: ['stats'] },
    };

    const warnings = __testing__.detectSharedCollections(readModels, 'items', [
      'items',
      'tags',
    ]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/orders/);
    expect(warnings[0]).toMatch(/items/);
  });

  test('returns empty array when no shared collections', () => {
    const readModels = {
      items: { collections: ['items'] },
      orders: { collections: ['orders'] },
    };

    const warnings = __testing__.detectSharedCollections(readModels, 'items', [
      'items',
    ]);

    expect(warnings).toEqual([]);
  });

  test('uses read model name as default collection', () => {
    const readModels = {
      items: {},
      orders: {},
    };

    const warnings = __testing__.detectSharedCollections(readModels, 'items', [
      'items',
    ]);

    expect(warnings).toEqual([]);
  });
});

describe('statusHandler', () => {
  test('returns service status with read model list', () => {
    const context = {
      correlationConfig: { serviceId: 'TEST' },
      readModels: {
        items: { lastProjectedEventTimestamp: 100 },
        orders: { lastProjectedEventTimestamp: 200 },
      },
      projectionHandler: {
        getReadModelReplayStates: vi.fn().mockReturnValue({ items: true }),
      },
    };
    const handler = statusHandler(context);
    const req = mockReq();
    const res = mockRes();

    handler(req, res);

    const response = res.json.mock.calls[0][0];
    expect(response.service).toBe('TEST');
    expect(typeof response.uptime).toBe('number');
    expect(response.readModels).toEqual([
      {
        name: 'items',
        lastProjectedEventTimestamp: 100,
        replaying: true,
      },
      {
        name: 'orders',
        lastProjectedEventTimestamp: 200,
        replaying: false,
      },
    ]);
  });

  test('defaults lastProjectedEventTimestamp to 0', () => {
    const context = {
      correlationConfig: { serviceId: 'TEST' },
      readModels: { items: {} },
      projectionHandler: {
        getReadModelReplayStates: vi.fn().mockReturnValue({}),
      },
    };
    const handler = statusHandler(context);
    const req = mockReq();
    const res = mockRes();

    handler(req, res);

    const response = res.json.mock.calls[0][0];
    expect(response.readModels[0].lastProjectedEventTimestamp).toBe(0);
  });
});

describe('readModelsHandler', () => {
  test('returns read model details with status', () => {
    const context = {
      readModels: {
        items: {
          lastProjectedEventTimestamp: 100,
          collections: ['items', 'itemTags'],
        },
        orders: { lastProjectedEventTimestamp: 200 },
      },
      projectionHandler: {
        getReadModelReplayStates: vi.fn().mockReturnValue({ items: true }),
      },
    };
    const handler = readModelsHandler(context);
    const req = mockReq();
    const res = mockRes();

    handler(req, res);

    expect(res.json).toHaveBeenCalledWith([
      {
        name: 'items',
        lastProjectedEventTimestamp: 100,
        status: 'replaying',
        collections: ['items', 'itemTags'],
      },
      {
        name: 'orders',
        lastProjectedEventTimestamp: 200,
        status: 'active',
        collections: ['orders'],
      },
    ]);
  });
});

describe('createBackupHandler', () => {
  let context;

  beforeEach(() => {
    vi.clearAllMocks();
    context = {
      readModels: {
        items: { collections: ['items'] },
      },
      backup: {
        createBackup: vi.fn().mockResolvedValue({
          backupId: 'backup_123_items',
          timestamp: 123,
          eventTimestamp: 100,
        }),
      },
    };
  });

  test('returns 404 for unknown read model', () => {
    const handler = createBackupHandler(context);
    const req = mockReq({}, { readModelName: 'unknown' });
    const res = mockRes();

    handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('returns 501 if backup not configured', () => {
    context.backup = undefined;
    const handler = createBackupHandler(context);
    const req = mockReq({}, { readModelName: 'items' });
    const res = mockRes();

    handler(req, res);

    expect(res.status).toHaveBeenCalledWith(501);
  });

  test('creates backup and returns result', () => {
    const handler = createBackupHandler(context);
    const req = mockReq({}, { readModelName: 'items' });
    const res = mockRes();

    return handler(req, res).then(() => {
      expect(context.backup.createBackup).toHaveBeenCalledWith(
        'test-corr-id',
        'items',
        ['items'],
      );
      expect(res.json).toHaveBeenCalledWith({
        backupId: 'backup_123_items',
        timestamp: 123,
        eventTimestamp: 100,
      });
    });
  });

  test('uses default collection name when not specified', () => {
    context.readModels.orders = {};
    const handler = createBackupHandler(context);
    const req = mockReq({}, { readModelName: 'orders' });
    const res = mockRes();

    return handler(req, res).then(() => {
      expect(context.backup.createBackup).toHaveBeenCalledWith(
        'test-corr-id',
        'orders',
        ['orders'],
      );
    });
  });

  test('returns 500 on backup error', () => {
    context.backup.createBackup.mockRejectedValue(new Error('disk full'));
    const handler = createBackupHandler(context);
    const req = mockReq({}, { readModelName: 'items' });
    const res = mockRes();

    return handler(req, res).then(() => {
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });
});

describe('listBackupsHandler', () => {
  test('returns 404 for unknown read model', () => {
    const context = {
      readModels: {},
      backup: { listBackups: vi.fn() },
    };
    const handler = listBackupsHandler(context);
    const req = mockReq({}, { readModelName: 'unknown' });
    const res = mockRes();

    handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('returns 501 if backup not configured', () => {
    const context = { readModels: { items: {} }, backup: undefined };
    const handler = listBackupsHandler(context);
    const req = mockReq({}, { readModelName: 'items' });
    const res = mockRes();

    handler(req, res);

    expect(res.status).toHaveBeenCalledWith(501);
  });

  test('lists backups for read model', () => {
    const backups = [
      { backupId: 'b1', timestamp: 100, eventTimestamp: 90 },
      { backupId: 'b2', timestamp: 200, eventTimestamp: 190 },
    ];
    const context = {
      readModels: { items: {} },
      backup: { listBackups: vi.fn().mockResolvedValue(backups) },
    };
    const handler = listBackupsHandler(context);
    const req = mockReq({}, { readModelName: 'items' });
    const res = mockRes();

    return handler(req, res).then(() => {
      expect(context.backup.listBackups).toHaveBeenCalledWith('items');
      expect(res.json).toHaveBeenCalledWith(backups);
    });
  });
});

describe('deleteBackupHandler', () => {
  test('returns 501 if backup not configured', () => {
    const context = { backup: undefined };
    const handler = deleteBackupHandler(context);
    const req = mockReq({}, { backupId: 'b1' });
    const res = mockRes();

    handler(req, res);

    expect(res.status).toHaveBeenCalledWith(501);
  });

  test('deletes backup and returns 204', () => {
    const context = {
      backup: { deleteBackup: vi.fn().mockResolvedValue() },
    };
    const handler = deleteBackupHandler(context);
    const req = mockReq({}, { backupId: 'b1' });
    const res = mockRes();

    return handler(req, res).then(() => {
      expect(context.backup.deleteBackup).toHaveBeenCalledWith(
        'test-corr-id',
        'b1',
      );
      expect(res.sendStatus).toHaveBeenCalledWith(204);
    });
  });

  test('returns 500 on error', () => {
    const context = {
      backup: {
        deleteBackup: vi.fn().mockRejectedValue(new Error('not found')),
      },
    };
    const handler = deleteBackupHandler(context);
    const req = mockReq({}, { backupId: 'b1' });
    const res = mockRes();

    return handler(req, res).then(() => {
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });
});

describe('prepareReplayHandler', () => {
  let context;

  beforeEach(() => {
    vi.clearAllMocks();
    context = {
      readModels: {
        items: {
          collections: ['items'],
          lastProjectedEventTimestamp: 500,
        },
      },
      projectionHandler: {
        isReadModelReplaying: vi.fn().mockReturnValue(false),
        setReadModelReplayState: vi.fn(),
        clearReadModelReplayState: vi.fn(),
      },
      backup: {
        createBackup: vi.fn().mockResolvedValue({
          backupId: 'backup_pre_items',
          timestamp: 1000,
          eventTimestamp: 500,
        }),
        restoreBackup: vi.fn().mockResolvedValue(),
        clearCollections: vi.fn().mockResolvedValue(),
        listBackups: vi.fn().mockResolvedValue([
          {
            backupId: 'backup_old_items',
            eventTimestamp: 300,
          },
        ]),
      },
      storage: {
        perRequest: vi.fn().mockReturnValue({
          updateOne: vi.fn().mockResolvedValue(),
        }),
      },
      correlationConfig: { serviceId: 'test-service' },
    };
  });

  test('returns 404 for unknown read model', () => {
    const handler = prepareReplayHandler(context);
    const req = mockReq({}, { readModelName: 'unknown' });
    const res = mockRes();

    handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('returns 409 if already replaying', () => {
    context.projectionHandler.isReadModelReplaying.mockReturnValue(true);
    const handler = prepareReplayHandler(context);
    const req = mockReq({}, { readModelName: 'items' });
    const res = mockRes();

    handler(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
  });

  test('returns 501 if backup required but not configured', () => {
    context.backup = undefined;
    const handler = prepareReplayHandler(context);
    const req = mockReq({ fromScratch: true }, { readModelName: 'items' });
    const res = mockRes();

    handler(req, res);

    expect(res.status).toHaveBeenCalledWith(501);
  });

  test('prepares replay from current state (default)', () => {
    const handler = prepareReplayHandler(context);
    const req = mockReq({}, { readModelName: 'items' });
    const res = mockRes();

    return handler(req, res).then(() => {
      expect(context.backup.createBackup).toHaveBeenCalledWith(
        'test-corr-id',
        'items',
        ['items'],
      );
      expect(
        context.projectionHandler.setReadModelReplayState,
      ).toHaveBeenCalledWith('items', true);
      expect(context.storage.perRequest).toHaveBeenCalledWith('test-corr-id');
      expect(res.json).toHaveBeenCalledWith({
        status: 'prepared',
        readModel: 'items',
        fromTimestamp: 500,
        preReplayBackupId: 'backup_pre_items',
        warnings: [],
        serviceId: 'test-service',
      });
    });
  });

  test('prepares replay from scratch', () => {
    const handler = prepareReplayHandler(context);
    const req = mockReq({ fromScratch: true }, { readModelName: 'items' });
    const res = mockRes();

    return handler(req, res).then(() => {
      expect(context.backup.clearCollections).toHaveBeenCalledWith(
        'test-corr-id',
        'items',
        ['items'],
      );
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ fromTimestamp: 0 }),
      );
    });
  });

  test('prepares replay from backup', () => {
    const handler = prepareReplayHandler(context);
    const req = mockReq(
      { backupId: 'backup_old_items' },
      { readModelName: 'items' },
    );
    const res = mockRes();

    return handler(req, res).then(() => {
      expect(context.backup.restoreBackup).toHaveBeenCalledWith(
        'test-corr-id',
        'items',
        'backup_old_items',
      );
      expect(context.backup.listBackups).toHaveBeenCalledWith('items');
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ fromTimestamp: 300 }),
      );
    });
  });

  test('defaults fromTimestamp to 0 when backup not found', () => {
    context.backup.listBackups.mockResolvedValue([]);
    const handler = prepareReplayHandler(context);
    const req = mockReq(
      { backupId: 'nonexistent' },
      { readModelName: 'items' },
    );
    const res = mockRes();

    return handler(req, res).then(() => {
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ fromTimestamp: 0 }),
      );
    });
  });

  test('detects shared collections and includes warnings', () => {
    context.readModels.orders = {
      collections: ['items', 'orderLines'],
      lastProjectedEventTimestamp: 400,
    };
    const handler = prepareReplayHandler(context);
    const req = mockReq({}, { readModelName: 'items' });
    const res = mockRes();

    return handler(req, res).then(() => {
      const response = res.json.mock.calls[0][0];
      expect(response.warnings).toHaveLength(1);
      expect(response.warnings[0]).toMatch(/orders/);
      expect(response.warnings[0]).toMatch(/items/);
    });
  });

  test('marks replayInProgress in readmodel.state', () => {
    const handler = prepareReplayHandler(context);
    const req = mockReq({}, { readModelName: 'items' });
    const res = mockRes();

    return handler(req, res).then(() => {
      const updateOne =
        context.storage.perRequest.mock.results[0].value.updateOne;
      expect(updateOne).toHaveBeenCalledWith(
        'readmodel.state',
        { name: 'items' },
        {
          $set: {
            replayInProgress: true,
            preReplayBackupId: 'backup_pre_items',
          },
        },
      );
    });
  });

  test('clears replay state on error', () => {
    context.backup.createBackup.mockRejectedValue(new Error('backup failed'));
    const handler = prepareReplayHandler(context);
    const req = mockReq({}, { readModelName: 'items' });
    const res = mockRes();

    return handler(req, res).then(() => {
      expect(
        context.projectionHandler.clearReadModelReplayState,
      ).toHaveBeenCalledWith('items');
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  test('works without backup configured (simple replay)', () => {
    context.backup = undefined;
    const handler = prepareReplayHandler(context);
    const req = mockReq({}, { readModelName: 'items' });
    const res = mockRes();

    return handler(req, res).then(() => {
      expect(
        context.projectionHandler.setReadModelReplayState,
      ).toHaveBeenCalledWith('items', true);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'prepared',
          preReplayBackupId: null,
          fromTimestamp: 500,
        }),
      );
    });
  });
});

describe('replayReadModelStatusHandler', () => {
  test('returns 404 for unknown read model', () => {
    const context = {
      readModels: {},
      projectionHandler: {
        isReadModelReplaying: vi.fn(),
      },
    };
    const handler = replayReadModelStatusHandler(context);
    const req = mockReq({}, { readModelName: 'unknown' });
    const res = mockRes();

    handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('returns in_progress when replaying', () => {
    const context = {
      readModels: {
        items: { lastProjectedEventTimestamp: 500 },
      },
      projectionHandler: {
        isReadModelReplaying: vi.fn().mockReturnValue(true),
      },
    };
    const handler = replayReadModelStatusHandler(context);
    const req = mockReq({}, { readModelName: 'items' });
    const res = mockRes();

    handler(req, res);

    expect(res.json).toHaveBeenCalledWith({
      readModel: 'items',
      status: 'in_progress',
      lastProjectedEventTimestamp: 500,
    });
  });

  test('returns idle when not replaying', () => {
    const context = {
      readModels: {
        items: { lastProjectedEventTimestamp: 500 },
      },
      projectionHandler: {
        isReadModelReplaying: vi.fn().mockReturnValue(false),
      },
    };
    const handler = replayReadModelStatusHandler(context);
    const req = mockReq({}, { readModelName: 'items' });
    const res = mockRes();

    handler(req, res);

    expect(res.json).toHaveBeenCalledWith({
      readModel: 'items',
      status: 'idle',
      lastProjectedEventTimestamp: 500,
    });
  });

  test('defaults lastProjectedEventTimestamp to 0', () => {
    const context = {
      readModels: { items: {} },
      projectionHandler: {
        isReadModelReplaying: vi.fn().mockReturnValue(false),
      },
    };
    const handler = replayReadModelStatusHandler(context);
    const req = mockReq({}, { readModelName: 'items' });
    const res = mockRes();

    handler(req, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ lastProjectedEventTimestamp: 0 }),
    );
  });
});

describe('resetReplayStateHandler', () => {
  test('returns 404 for unknown read model', () => {
    const context = {
      readModels: {},
      projectionHandler: {
        clearReadModelReplayState: vi.fn(),
      },
    };
    const handler = resetReplayStateHandler(context);
    const req = mockReq({}, { readModelName: 'unknown' });
    const res = mockRes();

    handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Read model unknown not found',
    });
  });

  test('resets replay state and returns 200', () => {
    const context = {
      readModels: { items: {} },
      projectionHandler: {
        clearReadModelReplayState: vi.fn(),
      },
    };
    const handler = resetReplayStateHandler(context);
    const req = mockReq({}, { readModelName: 'items' });
    const res = mockRes();

    handler(req, res);

    expect(
      context.projectionHandler.clearReadModelReplayState,
    ).toHaveBeenCalledWith('items');
    expect(res.json).toHaveBeenCalledWith({
      status: 'reset',
      readModel: 'items',
    });
  });

  test('calls clearReadModelReplayState with correct name', () => {
    const context = {
      readModels: { orders: {} },
      projectionHandler: {
        clearReadModelReplayState: vi.fn(),
      },
    };
    const handler = resetReplayStateHandler(context);
    const req = mockReq({}, { readModelName: 'orders' });
    const res = mockRes();

    handler(req, res);

    expect(
      context.projectionHandler.clearReadModelReplayState,
    ).toHaveBeenCalledTimes(1);
    expect(
      context.projectionHandler.clearReadModelReplayState,
    ).toHaveBeenCalledWith('orders');
  });
});
