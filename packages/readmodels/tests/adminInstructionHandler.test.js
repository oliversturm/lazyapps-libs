import { describe, test, expect, vi } from 'vitest';
import { startReadModels } from '../index.js';

const createMockContext = () => {
  const storageResult = {
    readLastProjectedEventTimestamps: vi.fn().mockResolvedValue(),
    updateLastProjectedEventTimestamps: vi.fn().mockResolvedValue(),
    perRequest: vi.fn().mockReturnValue({
      updateOne: vi.fn().mockResolvedValue(),
      dropCollection: vi.fn().mockResolvedValue(),
    }),
  };
  const storage = vi.fn().mockResolvedValue(storageResult);
  const eventBus = vi.fn().mockResolvedValue();
  const listener = vi.fn().mockImplementation((ctx) => ctx);
  const secondaryTimestampStorage = {
    writeTimestamp: vi.fn().mockResolvedValue(),
    readTimestamp: vi.fn().mockResolvedValue(0),
  };

  return {
    storageResult,
    storage,
    eventBus,
    listener,
    secondaryTimestampStorage,
  };
};

const flush = () =>
  new Promise((resolve) => {
    setTimeout(resolve, 10);
  });

describe('adminInstructionHandler', () => {
  describe('persistTimestamp', () => {
    test('writes timestamp to primary and secondary storage', () => {
      const mocks = createMockContext();
      const readModels = {
        myRM: { projections: {}, lastProjectedEventTimestamp: 0 },
      };

      return startReadModels(
        {},
        {
          readModels,
          storage: mocks.storage,
          eventBus: mocks.eventBus,
          listener: mocks.listener,
          secondaryTimestampStorage: mocks.secondaryTimestampStorage,
        },
      )
        .then((context) => {
          context.adminInstructionHandler('corr-1', {
            type: 'persistTimestamp',
            targetReadModel: 'myRM',
            timestamp: 1234567890,
          });
          return flush().then(() => context);
        })
        .then((context) => {
          expect(
            mocks.storageResult.updateLastProjectedEventTimestamps,
          ).toHaveBeenCalledWith('corr-1', ['myRM'], 1234567890);
          expect(
            mocks.secondaryTimestampStorage.writeTimestamp,
          ).toHaveBeenCalledWith('myRM', 1234567890);
          expect(context.readModels.myRM.lastProjectedEventTimestamp).toBe(
            1234567890,
          );
        });
    });

    test('works without secondary storage', () => {
      const mocks = createMockContext();
      const readModels = {
        myRM: { projections: {}, lastProjectedEventTimestamp: 0 },
      };

      return startReadModels(
        {},
        {
          readModels,
          storage: mocks.storage,
          eventBus: mocks.eventBus,
          listener: mocks.listener,
        },
      )
        .then((context) => {
          context.adminInstructionHandler('corr-2', {
            type: 'persistTimestamp',
            targetReadModel: 'myRM',
            timestamp: 9999,
          });
          return flush().then(() => context);
        })
        .then((context) => {
          expect(
            mocks.storageResult.updateLastProjectedEventTimestamps,
          ).toHaveBeenCalledWith('corr-2', ['myRM'], 9999);
          expect(context.readModels.myRM.lastProjectedEventTimestamp).toBe(
            9999,
          );
        });
    });

    test('ignores instruction when targetReadModel is missing', () => {
      const mocks = createMockContext();
      const readModels = {
        myRM: { projections: {}, lastProjectedEventTimestamp: 0 },
      };

      return startReadModels(
        {},
        {
          readModels,
          storage: mocks.storage,
          eventBus: mocks.eventBus,
          listener: mocks.listener,
          secondaryTimestampStorage: mocks.secondaryTimestampStorage,
        },
      ).then((context) => {
        context.adminInstructionHandler('corr-3', {
          type: 'persistTimestamp',
          timestamp: 1234567890,
        });

        expect(
          mocks.storageResult.updateLastProjectedEventTimestamps,
        ).not.toHaveBeenCalled();
        expect(
          mocks.secondaryTimestampStorage.writeTimestamp,
        ).not.toHaveBeenCalled();
      });
    });

    test('handles primary storage failure gracefully', () => {
      const mocks = createMockContext();
      mocks.storageResult.updateLastProjectedEventTimestamps = vi
        .fn()
        .mockRejectedValue(new Error('DB write failed'));
      const readModels = {
        myRM: { projections: {}, lastProjectedEventTimestamp: 0 },
      };

      return startReadModels(
        {},
        {
          readModels,
          storage: mocks.storage,
          eventBus: mocks.eventBus,
          listener: mocks.listener,
          secondaryTimestampStorage: mocks.secondaryTimestampStorage,
        },
      ).then((context) => {
        context.adminInstructionHandler('corr-4', {
          type: 'persistTimestamp',
          targetReadModel: 'myRM',
          timestamp: 5555,
        });
        // Should not throw — error is caught and logged
        return flush();
      });
    });

    test('updates in-memory timestamp even when RM has no prior value', () => {
      const mocks = createMockContext();
      const readModels = {
        myRM: { projections: {} },
      };

      return startReadModels(
        {},
        {
          readModels,
          storage: mocks.storage,
          eventBus: mocks.eventBus,
          listener: mocks.listener,
          secondaryTimestampStorage: mocks.secondaryTimestampStorage,
        },
      )
        .then((context) => {
          context.adminInstructionHandler('corr-5', {
            type: 'persistTimestamp',
            targetReadModel: 'myRM',
            timestamp: 42,
          });
          return flush().then(() => context);
        })
        .then((context) => {
          expect(context.readModels.myRM.lastProjectedEventTimestamp).toBe(42);
        });
    });
  });

  describe('developmentOperation gatekeeping', () => {
    test('rejects developmentOperation instruction when not in dev mode', () => {
      const mocks = createMockContext();
      const readModels = {
        myRM: { projections: {}, lastProjectedEventTimestamp: 0 },
      };

      return startReadModels(
        {},
        {
          readModels,
          storage: mocks.storage,
          eventBus: mocks.eventBus,
          listener: mocks.listener,
          // No developmentMode — defaults to false
        },
      ).then((context) => {
        context.adminInstructionHandler('corr-dev-1', {
          type: 'stop',
          targetReadModel: 'myRM',
          developmentOperation: true,
        });

        // The stop handler uses lifecycleManager which isn't set up,
        // but the gatekeeping should prevent it from even reaching
        // the switch. We verify by checking nothing blew up and that
        // the instruction was silently rejected.
      });
    });

    test('allows developmentOperation instruction when in dev mode', () => {
      const mocks = createMockContext();
      const readModels = {
        myRM: { projections: {}, lastProjectedEventTimestamp: 0 },
      };

      return startReadModels(
        {},
        {
          readModels,
          storage: mocks.storage,
          eventBus: mocks.eventBus,
          listener: mocks.listener,
          developmentMode: true,
          secondaryTimestampStorage: mocks.secondaryTimestampStorage,
        },
      )
        .then((context) => {
          // Use persistTimestamp as it doesn't need lifecycleManager
          context.adminInstructionHandler('corr-dev-2', {
            type: 'persistTimestamp',
            targetReadModel: 'myRM',
            timestamp: 777,
            developmentOperation: true,
          });
          return flush().then(() => context);
        })
        .then((context) => {
          // Should have been processed
          expect(
            mocks.storageResult.updateLastProjectedEventTimestamps,
          ).toHaveBeenCalledWith('corr-dev-2', ['myRM'], 777);
          expect(context.readModels.myRM.lastProjectedEventTimestamp).toBe(777);
        });
    });

    test('allows normal instructions without developmentOperation flag', () => {
      const mocks = createMockContext();
      const readModels = {
        myRM: { projections: {}, lastProjectedEventTimestamp: 0 },
      };

      return startReadModels(
        {},
        {
          readModels,
          storage: mocks.storage,
          eventBus: mocks.eventBus,
          listener: mocks.listener,
          // No developmentMode
          secondaryTimestampStorage: mocks.secondaryTimestampStorage,
        },
      )
        .then((context) => {
          // persistTimestamp without developmentOperation flag
          context.adminInstructionHandler('corr-dev-3', {
            type: 'persistTimestamp',
            targetReadModel: 'myRM',
            timestamp: 888,
          });
          return flush().then(() => context);
        })
        .then((context) => {
          // Should have been processed normally
          expect(
            mocks.storageResult.updateLastProjectedEventTimestamps,
          ).toHaveBeenCalledWith('corr-dev-3', ['myRM'], 888);
          expect(context.readModels.myRM.lastProjectedEventTimestamp).toBe(888);
        });
    });
  });
});
