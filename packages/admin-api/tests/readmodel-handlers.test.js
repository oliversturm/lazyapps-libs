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
  replayReadModelStatusHandler,
  adminStatusHandler,
  adminReadModelsHandler,
  adminReplayReadModelStatusHandler,
  createBackupHandler,
  listBackupsHandler,
  deleteBackupHandler,
  prepareReplayHandler,
  resetReplayStateHandler,
  activateReadModelHandler,
  stopReadModelHandler,
  activateAllHandler,
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

// --- RM-service handler tests ---

describe('statusHandler (RM service)', () => {
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

describe('readModelsHandler (RM service)', () => {
  test('returns read model details with endpointName', () => {
    const context = {
      correlationConfig: { serviceId: 'RM/CUS' },
      endpointName: 'RM/CUS',
      readModels: {
        items: { lastProjectedEventTimestamp: 100 },
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
        endpointName: 'RM/CUS',
        lastProjectedEventTimestamp: 100,
        status: 'replaying',
      },
      {
        name: 'orders',
        endpointName: 'RM/CUS',
        lastProjectedEventTimestamp: 200,
        status: 'active',
      },
    ]);
  });
});

describe('replayReadModelStatusHandler (RM service)', () => {
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

// --- Admin-service handler tests ---

describe('adminStatusHandler (admin service)', () => {
  test('proxies to RM services via activator', () => {
    const context = {
      correlationConfig: { serviceId: 'ADMIN' },
      projectionHandler: {
        getReadModelReplayStates: vi.fn().mockReturnValue({}),
      },
      activator: {
        fetchReadModels: vi.fn().mockResolvedValue([
          {
            name: 'items',
            lastProjectedEventTimestamp: 100,
            endpointName: 'RM1',
          },
          {
            name: 'orders',
            lastProjectedEventTimestamp: 200,
            endpointName: 'RM2',
          },
        ]),
      },
    };
    const handler = adminStatusHandler(context);
    const req = mockReq();
    const res = mockRes();

    return handler(req, res).then(() => {
      const response = res.json.mock.calls[0][0];
      expect(response.service).toBe('ADMIN');
      expect(response.readModels).toHaveLength(2);
      expect(response.readModels[0].name).toBe('items');
    });
  });

  test('returns empty readModels on fetch failure', () => {
    const context = {
      correlationConfig: { serviceId: 'ADMIN' },
      projectionHandler: {
        getReadModelReplayStates: vi.fn().mockReturnValue({}),
      },
      activator: {
        fetchReadModels: vi
          .fn()
          .mockRejectedValue(new Error('connection refused')),
      },
    };
    const handler = adminStatusHandler(context);
    const req = mockReq();
    const res = mockRes();

    return handler(req, res).then(() => {
      const response = res.json.mock.calls[0][0];
      expect(response.readModels).toEqual([]);
    });
  });
});

describe('adminReadModelsHandler (admin service)', () => {
  test('proxies to RM services via activator', () => {
    const context = {
      correlationConfig: { serviceId: 'ADMIN' },
      projectionHandler: {
        getReadModelReplayStates: vi.fn().mockReturnValue({}),
      },
      activator: {
        fetchReadModels: vi.fn().mockResolvedValue([
          {
            name: 'overview',
            endpointName: 'RM/CUS',
            lastProjectedEventTimestamp: 100,
            status: 'active',
          },
          {
            name: 'editing',
            endpointName: 'RM/CUS',
            lastProjectedEventTimestamp: 200,
            status: 'active',
          },
        ]),
      },
    };
    const handler = adminReadModelsHandler(context);
    const req = mockReq();
    const res = mockRes();

    return handler(req, res).then(() => {
      expect(context.activator.fetchReadModels).toHaveBeenCalled();
      const response = res.json.mock.calls[0][0];
      expect(response).toHaveLength(2);
      expect(response[0].endpointName).toBe('RM/CUS');
    });
  });

  test('returns 503 when activator proxy fails', () => {
    const context = {
      correlationConfig: { serviceId: 'ADMIN' },
      projectionHandler: {
        getReadModelReplayStates: vi.fn().mockReturnValue({}),
      },
      activator: {
        fetchReadModels: vi
          .fn()
          .mockRejectedValue(new Error('connection refused')),
      },
    };
    const handler = adminReadModelsHandler(context);
    const req = mockReq();
    const res = mockRes();

    return handler(req, res).then(() => {
      expect(res.status).toHaveBeenCalledWith(503);
    });
  });
});

describe('adminReplayReadModelStatusHandler (admin service)', () => {
  test('returns 404 for unknown read model', () => {
    const context = {
      activator: {
        getDiscoveredReadModel: vi.fn().mockReturnValue(undefined),
      },
      projectionHandler: {
        isReadModelReplaying: vi.fn(),
        getReadModelTerminalStatus: vi.fn().mockReturnValue(null),
      },
    };
    const handler = adminReplayReadModelStatusHandler(context);
    const req = mockReq({}, { readModelName: 'unknown' });
    const res = mockRes();

    handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('finds read model via activator discovery', () => {
    const context = {
      activator: {
        getDiscoveredReadModel: vi.fn().mockReturnValue({
          name: 'items',
          endpointName: 'RM/CUS',
          lastProjectedEventTimestamp: 500,
        }),
      },
      projectionHandler: {
        isReadModelReplaying: vi.fn().mockReturnValue(false),
        getReadModelTerminalStatus: vi.fn().mockReturnValue(null),
      },
    };
    const handler = adminReplayReadModelStatusHandler(context);
    const req = mockReq({}, { readModelName: 'items' });
    const res = mockRes();

    handler(req, res);

    expect(res.json).toHaveBeenCalledWith({
      readModel: 'items',
      status: 'idle',
      lastProjectedEventTimestamp: 500,
    });
  });
});

// --- Shared admin handler tests (backup, replay, activate, stop) ---
// These handlers are mounted by installReadModelAdminApi, which is used by
// both admin services (with activator) and RM services (with local readModels).

describe('createBackupHandler', () => {
  let context;

  beforeEach(() => {
    vi.clearAllMocks();
    context = {
      readModels: {
        items: {},
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

  test('delegates to RM via message bus and returns result', () => {
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

  test('finds read model via activator discovery cache', () => {
    const ctx = {
      readModels: {},
      activator: {
        getDiscoveredReadModel: vi.fn().mockReturnValue({
          name: 'items',
          endpointName: 'RM/CUS',
        }),
      },
      eventBus: mockEventBus({
        correlationId: 'test-corr-id',
        backupId: 'backup_123_items',
      }),
    };
    const handler = createBackupHandler(ctx);
    const req = mockReq({}, { readModelName: 'items' });
    const res = mockRes();

    return handler(req, res).then(() => {
      expect(ctx.activator.getDiscoveredReadModel).toHaveBeenCalledWith(
        'items',
      );
      expect(res.json).toHaveBeenCalled();
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

  test('lists backups via message bus delegation', () => {
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

  test('deletes backup via message bus and returns 204', () => {
    const context = {
      readModels: { items: {} },
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
      readModels: { items: {} },
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
      endpointName: 'test-service',
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

  test('delegates prepare_for_replay to RM service via message bus', () => {
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
        endpointName: 'test-service',
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

  test('uses endpointName from activator discovery cache', () => {
    const ctx = {
      readModels: {},
      activator: {
        getDiscoveredReadModel: vi.fn().mockReturnValue({
          name: 'items',
          endpointName: 'RM/CUS',
          lastProjectedEventTimestamp: 500,
        }),
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
      correlationConfig: { serviceId: 'ADMIN' },
    };
    const handler = prepareReplayHandler(ctx);
    const req = mockReq({}, { readModelName: 'items' });
    const res = mockRes();

    return handler(req, res).then(() => {
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ endpointName: 'RM/CUS' }),
      );
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

describe('replayReadModelStatusHandler (via resolveReadModel)', () => {
  test('finds read model via activator discovery', () => {
    const context = {
      readModels: {},
      activator: {
        getDiscoveredReadModel: vi.fn().mockReturnValue({
          name: 'items',
          endpointName: 'RM/CUS',
          lastProjectedEventTimestamp: 500,
        }),
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

    // RM-service handler only checks context.readModels, so unknown
    // read models from activator will 404
    expect(res.status).toHaveBeenCalledWith(404);
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

  test('finds read model via activator when not in local readModels', () => {
    const context = {
      readModels: {},
      activator: {
        getDiscoveredReadModel: vi.fn().mockReturnValue({
          name: 'items',
          endpointName: 'RM/CUS',
        }),
      },
      projectionHandler: {
        clearReadModelReplayState: vi.fn(),
      },
    };
    const handler = resetReplayStateHandler(context);
    const req = mockReq({}, { readModelName: 'items' });
    const res = mockRes();

    handler(req, res);

    expect(context.activator.getDiscoveredReadModel).toHaveBeenCalledWith(
      'items',
    );
    expect(res.json).toHaveBeenCalledWith({
      status: 'reset',
      readModel: 'items',
    });
  });
});

describe('activateReadModelHandler', () => {
  test('returns 404 for unknown read model', () => {
    const context = {
      readModels: {},
    };
    const handler = activateReadModelHandler(context);
    const req = mockReq({}, { readModelName: 'unknown' });
    const res = mockRes();

    handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('activates via activator and returns 202', () => {
    const context = {
      readModels: {},
      activator: {
        getDiscoveredReadModel: vi.fn().mockReturnValue({
          name: 'items',
          endpointName: 'RM/CUS',
        }),
        activateReadModel: vi.fn().mockResolvedValue(undefined),
      },
    };
    const handler = activateReadModelHandler(context);
    const req = mockReq({}, { readModelName: 'items' });
    const res = mockRes();

    handler(req, res);

    expect(context.activator.activateReadModel).toHaveBeenCalledWith('items');
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith({
      status: 'activating',
      readModel: 'items',
    });
  });

  test('activates via lifecycle manager when no activator', () => {
    const context = {
      readModels: { items: {} },
      lifecycleManager: {
        getState: vi.fn().mockReturnValue('waiting'),
        activate: vi.fn().mockResolvedValue(undefined),
      },
    };
    const handler = activateReadModelHandler(context);
    const req = mockReq({}, { readModelName: 'items' });
    const res = mockRes();

    handler(req, res);

    expect(context.lifecycleManager.activate).toHaveBeenCalledWith(
      'items',
      'test-corr-id',
    );
    expect(res.status).toHaveBeenCalledWith(202);
  });

  test('returns 409 when lifecycle state prevents activation', () => {
    const context = {
      readModels: { items: {} },
      lifecycleManager: {
        getState: vi.fn().mockReturnValue('live'),
      },
    };
    const handler = activateReadModelHandler(context);
    const req = mockReq({}, { readModelName: 'items' });
    const res = mockRes();

    handler(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
  });

  test('returns 501 when no activator or lifecycle manager', () => {
    const context = {
      readModels: { items: {} },
    };
    const handler = activateReadModelHandler(context);
    const req = mockReq({}, { readModelName: 'items' });
    const res = mockRes();

    handler(req, res);

    expect(res.status).toHaveBeenCalledWith(501);
  });
});

describe('stopReadModelHandler', () => {
  test('returns 404 for unknown read model', () => {
    const context = {
      readModels: {},
    };
    const handler = stopReadModelHandler(context);
    const req = mockReq({}, { readModelName: 'unknown' });
    const res = mockRes();

    handler(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
  });

  test('stops via activator', () => {
    const context = {
      readModels: {},
      activator: {
        getDiscoveredReadModel: vi.fn().mockReturnValue({
          name: 'items',
          endpointName: 'RM/CUS',
        }),
        stopReadModel: vi.fn(),
      },
    };
    const handler = stopReadModelHandler(context);
    const req = mockReq({}, { readModelName: 'items' });
    const res = mockRes();

    handler(req, res);

    expect(context.activator.stopReadModel).toHaveBeenCalledWith('items');
    expect(res.json).toHaveBeenCalledWith({
      status: 'stopped',
      readModel: 'items',
    });
  });

  test('stops via lifecycle manager when no activator', () => {
    const context = {
      readModels: { items: {} },
      lifecycleManager: {
        stop: vi.fn(),
      },
    };
    const handler = stopReadModelHandler(context);
    const req = mockReq({}, { readModelName: 'items' });
    const res = mockRes();

    handler(req, res);

    expect(context.lifecycleManager.stop).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      status: 'stopped',
      readModel: 'items',
    });
  });

  test('returns 501 when no activator or lifecycle manager', () => {
    const context = {
      readModels: { items: {} },
    };
    const handler = stopReadModelHandler(context);
    const req = mockReq({}, { readModelName: 'items' });
    const res = mockRes();

    handler(req, res);

    expect(res.status).toHaveBeenCalledWith(501);
  });
});

describe('activateAllHandler', () => {
  test('activates all discovered read models via activator', () => {
    const context = {
      activator: {
        getDiscoveredReadModels: vi.fn().mockReturnValue({
          items: { name: 'items', endpointName: 'RM/CUS' },
          orders: { name: 'orders', endpointName: 'RM/CUS' },
        }),
        activateReadModel: vi.fn().mockResolvedValue(undefined),
      },
    };
    const handler = activateAllHandler(context);
    const req = mockReq();
    const res = mockRes();

    handler(req, res);

    expect(context.activator.activateReadModel).toHaveBeenCalledWith('items');
    expect(context.activator.activateReadModel).toHaveBeenCalledWith('orders');
    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith({
      status: 'activating',
      readModels: ['items', 'orders'],
    });
  });

  test('activates via lifecycle manager when no activator', () => {
    const context = {
      readModels: {
        items: {},
        orders: {},
      },
      lifecycleManager: {
        getState: vi
          .fn()
          .mockReturnValueOnce('waiting')
          .mockReturnValueOnce('stopped'),
        activate: vi.fn().mockResolvedValue(undefined),
      },
    };
    const handler = activateAllHandler(context);
    const req = mockReq();
    const res = mockRes();

    handler(req, res);

    expect(context.lifecycleManager.activate).toHaveBeenCalledTimes(2);
    expect(res.status).toHaveBeenCalledWith(202);
  });

  test('returns 501 when no activator or lifecycle manager', () => {
    const context = {
      readModels: { items: {} },
    };
    const handler = activateAllHandler(context);
    const req = mockReq();
    const res = mockRes();

    handler(req, res);

    expect(res.status).toHaveBeenCalledWith(501);
  });
});
