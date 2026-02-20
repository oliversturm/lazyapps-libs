import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

const { createForgetSubjectEndpoints } =
  await import('../forgetSubjectEndpoints.js');

const mockReq = (body = {}, auth = null) => ({ body, auth });
const mockRes = () => {
  const res = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
};

describe('createForgetSubjectEndpoints', () => {
  let routes;
  let mockApp;
  let mockEncryption;
  let mockRotateContextKey;

  beforeEach(() => {
    vi.clearAllMocks();
    routes = {};
    mockApp = {
      post: vi.fn((path, handler) => {
        routes[path] = handler;
      }),
    };
    mockRotateContextKey = vi.fn().mockResolvedValue();
    mockEncryption = Promise.resolve({
      rotateContextKey: mockRotateContextKey,
    });
  });

  const install = (context = {}) => {
    createForgetSubjectEndpoints(mockEncryption)(context, mockApp);
  };

  describe('route installation', () => {
    test('installs two POST routes', () => {
      install();
      expect(mockApp.post).toHaveBeenCalledTimes(2);
      expect(mockApp.post).toHaveBeenCalledWith(
        '/api/forget-subject',
        expect.any(Function),
      );
      expect(mockApp.post).toHaveBeenCalledWith(
        '/api/admin/rotate-context-key',
        expect.any(Function),
      );
    });
  });

  describe('forget-subject endpoint', () => {
    test('returns 400 when subjectId is missing', () => {
      install();
      const req = mockReq({});
      const res = mockRes();
      routes['/api/forget-subject'](req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Missing subjectId' });
    });

    test('returns 500 when aggregate not registered', () => {
      install({ aggregates: {} });
      const req = mockReq({ subjectId: 'cust-1' });
      const res = mockRes();
      routes['/api/forget-subject'](req, res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: 'subjectLifecycle aggregate not found',
      });
    });

    test('returns 500 when FORGET_SUBJECT command not found on aggregate', () => {
      install({
        aggregates: { subjectLifecycle: { commands: {} } },
      });
      const req = mockReq({ subjectId: 'cust-1' });
      const res = mockRes();
      routes['/api/forget-subject'](req, res);
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: 'FORGET_SUBJECT command not found',
      });
    });

    test('calls handleCommand with correct arguments on valid request', async () => {
      const handleCommand = vi.fn().mockResolvedValue();
      const customCommandHandler = vi.fn();
      const context = {
        handleCommand,
        aggregateStore: 'mock-aggStore',
        eventStore: 'mock-eventStore',
        eventBus: 'mock-eventBus',
        aggregates: {
          subjectLifecycle: {
            commands: { FORGET_SUBJECT: customCommandHandler },
          },
        },
      };
      install(context);

      const req = mockReq({ subjectId: 'cust-42' });
      const res = mockRes();
      routes['/api/forget-subject'](req, res);

      await vi.waitFor(() => {
        expect(handleCommand).toHaveBeenCalledWith(
          'mock-aggStore',
          'mock-eventStore',
          'mock-eventBus',
          'FORGET_SUBJECT',
          'subjectLifecycle',
          'cust-42',
          expect.objectContaining({ subjectId: 'cust-42' }),
          customCommandHandler,
          null,
          expect.any(Number),
          undefined,
        );
      });
    });

    test('resolves aggregate from context and uses its handler', async () => {
      const customHandler = vi.fn();
      const handleCommand = vi.fn().mockResolvedValue();
      const context = {
        handleCommand,
        aggregateStore: {},
        eventStore: {},
        eventBus: {},
        aggregates: {
          subjectLifecycle: { commands: { FORGET_SUBJECT: customHandler } },
        },
      };
      install(context);

      const req = mockReq({ subjectId: 'cust-1' });
      const res = mockRes();
      routes['/api/forget-subject'](req, res);

      await vi.waitFor(() => {
        expect(handleCommand).toHaveBeenCalledOnce();
        // Verify the command handler reference from the aggregate is used
        expect(handleCommand.mock.calls[0][7]).toBe(customHandler);
        // Verify aggregate/event/bus stores are passed through
        expect(handleCommand.mock.calls[0][0]).toBe(context.aggregateStore);
        expect(handleCommand.mock.calls[0][1]).toBe(context.eventStore);
        expect(handleCommand.mock.calls[0][2]).toBe(context.eventBus);
      });
    });

    test('returns 200 with status on handleCommand success', async () => {
      const handleCommand = vi.fn().mockResolvedValue();
      install({
        handleCommand,
        aggregateStore: {},
        eventStore: {},
        eventBus: {},
        aggregates: {
          subjectLifecycle: {
            commands: { FORGET_SUBJECT: vi.fn() },
          },
        },
      });

      const req = mockReq({ subjectId: 'cust-42' });
      const res = mockRes();
      routes['/api/forget-subject'](req, res);

      await vi.waitFor(() => {
        expect(res.json).toHaveBeenCalledWith({
          status: 'forgotten',
          subjectId: 'cust-42',
        });
      });
    });

    test('returns 400 on ValidationError from handleCommand', async () => {
      const err = new Error('already forgotten');
      err.name = 'ValidationError';
      const handleCommand = vi.fn().mockRejectedValue(err);
      install({
        handleCommand,
        aggregateStore: {},
        eventStore: {},
        eventBus: {},
        aggregates: {
          subjectLifecycle: {
            commands: { FORGET_SUBJECT: vi.fn() },
          },
        },
      });

      const req = mockReq({ subjectId: 'cust-42' });
      const res = mockRes();
      routes['/api/forget-subject'](req, res);

      await vi.waitFor(() => {
        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ error: 'already forgotten' });
      });
    });

    test('returns 500 on other errors from handleCommand', async () => {
      const handleCommand = vi
        .fn()
        .mockRejectedValue(new Error('db connection lost'));
      install({
        handleCommand,
        aggregateStore: {},
        eventStore: {},
        eventBus: {},
        aggregates: {
          subjectLifecycle: {
            commands: { FORGET_SUBJECT: vi.fn() },
          },
        },
      });

      const req = mockReq({ subjectId: 'cust-42' });
      const res = mockRes();
      routes['/api/forget-subject'](req, res);

      await vi.waitFor(() => {
        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({
          error: 'db connection lost',
        });
      });
    });

    test('uses default payload values when not provided', async () => {
      const handleCommand = vi.fn().mockResolvedValue();
      install({
        handleCommand,
        aggregateStore: {},
        eventStore: {},
        eventBus: {},
        aggregates: {
          subjectLifecycle: {
            commands: { FORGET_SUBJECT: vi.fn() },
          },
        },
      });

      const req = mockReq({ subjectId: 'cust-42' });
      const res = mockRes();
      routes['/api/forget-subject'](req, res);

      await vi.waitFor(() => {
        const payload = handleCommand.mock.calls[0][6];
        expect(payload.subjectType).toBe('unknown');
        expect(payload.reason).toBe('Right to be forgotten');
        expect(payload.requestedBy).toBe('system');
      });
    });

    test('passes through custom payload values', async () => {
      const handleCommand = vi.fn().mockResolvedValue();
      install({
        handleCommand,
        aggregateStore: {},
        eventStore: {},
        eventBus: {},
        aggregates: {
          subjectLifecycle: {
            commands: { FORGET_SUBJECT: vi.fn() },
          },
        },
      });

      const req = mockReq(
        {
          subjectId: 'cust-42',
          subjectType: 'customer',
          reason: 'GDPR Article 17',
          requestedBy: 'dpo@company.com',
        },
        { sub: 'admin-user' },
      );
      const res = mockRes();
      routes['/api/forget-subject'](req, res);

      await vi.waitFor(() => {
        const payload = handleCommand.mock.calls[0][6];
        expect(payload.subjectType).toBe('customer');
        expect(payload.reason).toBe('GDPR Article 17');
        expect(payload.requestedBy).toBe('dpo@company.com');
      });
    });

    test('falls back to auth.sub for requestedBy', async () => {
      const handleCommand = vi.fn().mockResolvedValue();
      install({
        handleCommand,
        aggregateStore: {},
        eventStore: {},
        eventBus: {},
        aggregates: {
          subjectLifecycle: {
            commands: { FORGET_SUBJECT: vi.fn() },
          },
        },
      });

      const req = mockReq({ subjectId: 'cust-42' }, { sub: 'admin-user' });
      const res = mockRes();
      routes['/api/forget-subject'](req, res);

      await vi.waitFor(() => {
        const payload = handleCommand.mock.calls[0][6];
        expect(payload.requestedBy).toBe('admin-user');
      });
    });
  });

  describe('rotate-context-key endpoint', () => {
    test('returns 400 when contextName is missing', () => {
      install();
      const req = mockReq({});
      const res = mockRes();
      routes['/api/admin/rotate-context-key'](req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({ error: 'Missing contextName' });
    });

    test('calls enc.rotateContextKey on valid request', async () => {
      install();
      const req = mockReq({ contextName: 'personal' });
      const res = mockRes();
      routes['/api/admin/rotate-context-key'](req, res);

      await vi.waitFor(() => {
        expect(mockRotateContextKey).toHaveBeenCalledWith('personal');
      });
    });

    test('returns 200 with status on success', async () => {
      install();
      const req = mockReq({ contextName: 'personal' });
      const res = mockRes();
      routes['/api/admin/rotate-context-key'](req, res);

      await vi.waitFor(() => {
        expect(res.json).toHaveBeenCalledWith({
          status: 'rotated',
          context: 'personal',
        });
      });
    });

    test('returns 500 on error', async () => {
      mockRotateContextKey.mockRejectedValue(new Error('rotation failed'));
      mockEncryption = Promise.resolve({
        rotateContextKey: mockRotateContextKey,
      });
      install();
      const req = mockReq({ contextName: 'personal' });
      const res = mockRes();
      routes['/api/admin/rotate-context-key'](req, res);

      await vi.waitFor(() => {
        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({ error: 'rotation failed' });
      });
    });
  });
});
