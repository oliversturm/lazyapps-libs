import { describe, test, expect, vi } from 'vitest';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  }),
}));

const { createReadModelReplayHandler } = await import('../replayHandler.js');

const createMockContext = (overrides = {}) => {
  const findCursor = {
    toArray: vi.fn().mockResolvedValue([]),
  };
  return {
    storage: {
      perRequest: vi.fn().mockReturnValue({
        updateOne: vi.fn().mockResolvedValue(),
        find: vi.fn().mockReturnValue(findCursor),
      }),
    },
    readModels: {
      customers: {
        resolvers: {
          all: vi.fn(),
          byId: vi.fn(),
        },
      },
    },
    projectionHandler: {
      clearReadModelReplayState: vi.fn(),
    },
    changeNotification: vi.fn().mockReturnValue({
      sendChangeNotification: vi.fn().mockResolvedValue(),
      createChangeInfo: vi.fn((...args) => ({
        readModelName: args[0],
        resolverName: args[1],
        changeKind: args[2],
      })),
    }),
    ...overrides,
  };
};

describe('replayHandler', () => {
  describe('handleReplayComplete', () => {
    test('clears read model replay state', () => {
      const context = createMockContext();
      const handler = createReadModelReplayHandler(context);

      return handler.handleReplayComplete('customers').then(() => {
        expect(
          context.projectionHandler.clearReadModelReplayState,
        ).toHaveBeenCalledWith('customers');
      });
    });

    test('clears replayInProgress from readmodel.state', () => {
      const context = createMockContext();
      const handler = createReadModelReplayHandler(context);

      return handler.handleReplayComplete('customers').then(() => {
        const updateOne = context.storage.perRequest('replay').updateOne;
        expect(updateOne).toHaveBeenCalledWith(
          'readmodel.state',
          { name: 'customers' },
          { $unset: { replayInProgress: '', preReplayBackupId: '' } },
        );
      });
    });

    test('sends bulk refresh notifications for all resolvers', () => {
      const context = createMockContext();
      const handler = createReadModelReplayHandler(context);

      return handler.handleReplayComplete('customers').then(() => {
        const changeNotif = context.changeNotification('replay');
        expect(changeNotif.sendChangeNotification).toHaveBeenCalledTimes(2);
        expect(changeNotif.createChangeInfo).toHaveBeenCalledWith(
          'customers',
          'all',
          'all',
        );
        expect(changeNotif.createChangeInfo).toHaveBeenCalledWith(
          'customers',
          'byId',
          'all',
        );
      });
    });

    test('skips notifications for read model without resolvers', () => {
      const context = createMockContext({
        readModels: {
          noResolvers: {},
        },
      });
      const handler = createReadModelReplayHandler(context);

      return handler.handleReplayComplete('noResolvers').then(() => {
        expect(context.changeNotification).not.toHaveBeenCalled();
      });
    });
  });

  describe('handleReplayCancelled', () => {
    test('restores pre-replay backup when backupId exists', () => {
      const findCursor = {
        toArray: vi
          .fn()
          .mockResolvedValue([{ preReplayBackupId: 'backup_123' }]),
      };
      const backupModule = {
        restoreBackup: vi.fn().mockResolvedValue(),
      };
      const context = createMockContext({
        backup: backupModule,
        storage: {
          perRequest: vi.fn().mockReturnValue({
            updateOne: vi.fn().mockResolvedValue(),
            find: vi.fn().mockReturnValue(findCursor),
          }),
        },
      });
      const handler = createReadModelReplayHandler(context);

      return handler.handleReplayCancelled('customers').then(() => {
        expect(backupModule.restoreBackup).toHaveBeenCalledWith(
          'replay',
          'customers',
          'backup_123',
        );
      });
    });

    test('skips restore when no pre-replay backup exists', () => {
      const backupModule = {
        restoreBackup: vi.fn().mockResolvedValue(),
      };
      const context = createMockContext({
        backup: backupModule,
      });
      const handler = createReadModelReplayHandler(context);

      return handler.handleReplayCancelled('customers').then(() => {
        expect(backupModule.restoreBackup).not.toHaveBeenCalled();
      });
    });

    test('works without backup module', () => {
      const context = createMockContext();
      const handler = createReadModelReplayHandler(context);

      return handler.handleReplayCancelled('customers').then(() => {
        expect(
          context.projectionHandler.clearReadModelReplayState,
        ).toHaveBeenCalledWith('customers');
      });
    });

    test('clears replay state after restore', () => {
      const findCursor = {
        toArray: vi
          .fn()
          .mockResolvedValue([{ preReplayBackupId: 'backup_123' }]),
      };
      const context = createMockContext({
        backup: { restoreBackup: vi.fn().mockResolvedValue() },
        storage: {
          perRequest: vi.fn().mockReturnValue({
            updateOne: vi.fn().mockResolvedValue(),
            find: vi.fn().mockReturnValue(findCursor),
          }),
        },
      });
      const handler = createReadModelReplayHandler(context);

      return handler.handleReplayCancelled('customers').then(() => {
        expect(
          context.projectionHandler.clearReadModelReplayState,
        ).toHaveBeenCalledWith('customers');
        expect(
          context.storage.perRequest('replay').updateOne,
        ).toHaveBeenCalledWith(
          'readmodel.state',
          { name: 'customers' },
          { $unset: { replayInProgress: '', preReplayBackupId: '' } },
        );
      });
    });
  });
});
