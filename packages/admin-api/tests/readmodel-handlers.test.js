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

const mockReq = (body = {}, params = {}, query = {}) => ({
  body,
  params,
  query,
});

const mockRes = () => {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.sendStatus = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  return res;
};

const mockEventBus = (replyPayload) => {
  let replyHandler;
  return {
    subscribeAdminReply: vi.fn().mockImplementation((topic, handler) => {
      replyHandler = handler;
      return Promise.resolve();
    }),
    publishAdminInstruction: vi.fn().mockImplementation(() => (instruction) => {
      if (replyHandler && replyPayload) {
        Promise.resolve().then(() => replyHandler(replyPayload));
      }
    }),
  };
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
      eventBus: mockEventBus({
        correlationId: 'test-corr-id',
        backupId: 'backup_123_items',
        timestamp: 123,
        eventTimestamp: 100,
      }),
    };
  });

  test('returns 404 for unknown read model', () => {
    const handler = createBackupHandler(context);
    const req = mockReq({}, { readModelName: 'unknown' });
    const res = mockRes();

    handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('delegates to RM via event bus and returns result', () => {
    const handler = createBackupHandler(context);
    const req = mockReq({}, { readModelName: 'items' });
    const res = mockRes();

    return handler(req, res).then(() => {
      expect(context.eventBus.publishAdminInstruction).toHaveBeenCalledWith(
        'test-corr-id',
      );
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          backupId: 'backup_123_items',
          timestamp: 123,
          eventTimestamp: 100,
        }),
      );
    });
  });

  test('returns 500 on error reply', () => {
    context.eventBus = mockEventBus({ error: 'disk full' });
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
      eventBus: mockEventBus(),
    };
    const handler = listBackupsHandler(context);
    const req = mockReq({}, { readModelName: 'unknown' });
    const res = mockRes();

    handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('lists backups via event bus delegation', () => {
    const backups = [
      { backupId: 'b1', timestamp: 100, eventTimestamp: 90 },
      { backupId: 'b2', timestamp: 200, eventTimestamp: 190 },
    ];
    const context = {
      readModels: { items: {} },
      eventBus: mockEventBus({
        correlationId: 'test-corr-id',
        backups,
      }),
    };
    const handler = listBackupsHandler(context);
    const req = mockReq({}, { readModelName: 'items' });
    const res = mockRes();

    return handler(req, res).then(() => {
      expect(res.json).toHaveBeenCalledWith(backups);
    });
  });
});

describe('deleteBackupHandler', () => {
  test('returns 400 if readModelName query param missing', () => {
    const context = {
      eventBus: mockEventBus({ deleted: true }),
    };
    const handler = deleteBackupHandler(context);
    const req = mockReq({}, { backupId: 'b1' }, {});
    const res = mockRes();

    handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('deletes backup via event bus and returns 204', () => {
    const context = {
      eventBus: mockEventBus({
        correlationId: 'test-corr-id',
        deleted: true,
      }),
    };
    const handler = deleteBackupHandler(context);
    const req = mockReq({}, { backupId: 'b1' }, { readModelName: 'items' });
    const res = mockRes();

    return handler(req, res).then(() => {
      expect(res.sendStatus).toHaveBeenCalledWith(204);
    });
  });

  test('returns 500 on error reply', () => {
    const context = {
      eventBus: mockEventBus({ error: 'not found' }),
    };
    const handler = deleteBackupHandler(context);
    const req = mockReq({}, { backupId: 'b1' }, { readModelName: 'items' });
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
      eventBus: mockEventBus({
        fromTimestamp: 500,
        preReplayBackupId: 'backup_pre_items',
      }),
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

  test('delegates prepare_for_replay to RM service via event bus', () => {
    const handler = prepareReplayHandler(context);
    const req = mockReq({}, { readModelName: 'items' });
    const res = mockRes();

    return handler(req, res).then(() => {
      expect(
        context.projectionHandler.setReadModelReplayState,
      ).toHaveBeenCalledWith('items', true);
      expect(context.eventBus.publishAdminInstruction).toHaveBeenCalledWith(
        'test-corr-id',
      );
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

  test('delegates fromScratch to RM service', () => {
    context.eventBus = mockEventBus({
      fromTimestamp: 0,
      preReplayBackupId: 'backup_pre_items',
    });
    const handler = prepareReplayHandler(context);
    const req = mockReq({ fromScratch: true }, { readModelName: 'items' });
    const res = mockRes();

    return handler(req, res).then(() => {
      expect(context.eventBus.publishAdminInstruction).toHaveBeenCalledWith(
        'test-corr-id',
      );
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ fromTimestamp: 0 }),
      );
    });
  });

  test('delegates backupId to RM service', () => {
    context.eventBus = mockEventBus({
      fromTimestamp: 300,
      preReplayBackupId: 'backup_pre_items',
    });
    const handler = prepareReplayHandler(context);
    const req = mockReq(
      { backupId: 'backup_old_items' },
      { readModelName: 'items' },
    );
    const res = mockRes();

    return handler(req, res).then(() => {
      expect(context.eventBus.publishAdminInstruction).toHaveBeenCalledWith(
        'test-corr-id',
      );
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ fromTimestamp: 300 }),
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

  test('clears replay state on delegation error', () => {
    context.eventBus = mockEventBus({ error: 'backup failed' });
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
});

describe('replayReadModelStatusHandler', () => {
  test('returns 404 for unknown read model', () => {
    const context = {
      readModels: {},
      projectionHandler: {
        isReadModelReplaying: vi.fn(),
        getReadModelTerminalStatus: vi.fn().mockReturnValue(null),
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
        getReadModelTerminalStatus: vi.fn().mockReturnValue(null),
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
        getReadModelTerminalStatus: vi.fn().mockReturnValue(null),
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
        getReadModelTerminalStatus: vi.fn().mockReturnValue(null),
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

  test('returns completed status after replay completes', () => {
    const context = {
      readModels: {
        items: { lastProjectedEventTimestamp: 500 },
      },
      projectionHandler: {
        isReadModelReplaying: vi.fn().mockReturnValue(false),
        getReadModelTerminalStatus: vi.fn().mockReturnValue('completed'),
      },
    };
    const handler = replayReadModelStatusHandler(context);
    const req = mockReq({}, { readModelName: 'items' });
    const res = mockRes();

    handler(req, res);

    expect(res.json).toHaveBeenCalledWith({
      readModel: 'items',
      status: 'completed',
      lastProjectedEventTimestamp: 500,
    });
  });

  test('returns cancelled status after replay is cancelled', () => {
    const context = {
      readModels: {
        items: { lastProjectedEventTimestamp: 500 },
      },
      projectionHandler: {
        isReadModelReplaying: vi.fn().mockReturnValue(false),
        getReadModelTerminalStatus: vi.fn().mockReturnValue('cancelled'),
      },
    };
    const handler = replayReadModelStatusHandler(context);
    const req = mockReq({}, { readModelName: 'items' });
    const res = mockRes();

    handler(req, res);

    expect(res.json).toHaveBeenCalledWith({
      readModel: 'items',
      status: 'cancelled',
      lastProjectedEventTimestamp: 500,
    });
  });

  test('in_progress takes precedence over terminal status', () => {
    const context = {
      readModels: {
        items: { lastProjectedEventTimestamp: 500 },
      },
      projectionHandler: {
        isReadModelReplaying: vi.fn().mockReturnValue(true),
        getReadModelTerminalStatus: vi.fn().mockReturnValue('completed'),
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
