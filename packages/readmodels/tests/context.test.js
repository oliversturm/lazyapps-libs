import { describe, test, expect, vi, beforeEach } from 'vitest';
import { initializeContext } from '../context.js';

describe('context', () => {
  test('build', () => {
    const readModels = {};
    const storageResult = {
      readLastProjectedEventTimestamps: vi.fn().mockResolvedValue(),
    };
    const storage = vi.fn().mockResolvedValue(storageResult);
    const eventBus = vi.fn().mockResolvedValue();
    return initializeContext({}, { readModels, storage, eventBus }).then(
      (context) => {
        expect(context).toBeDefined();
        expect(context.storage).toBeDefined();
        expect(context.commands).toBeDefined();
        expect(context.sideEffects).toBeDefined();
        expect(context.changeNotification).toBeDefined();
        expect(context.projectionHandler).toBeDefined();
        expect(context.replayHandler).toBeDefined();
        expect(typeof context.replayHandler.handleReplayComplete).toBe(
          'function',
        );
        expect(typeof context.replayHandler.handleReplayCancelled).toBe(
          'function',
        );
        expect(eventBus).toHaveBeenCalledOnce();
      },
    );
  });

  test('build without backup omits backup from context', () => {
    const readModels = {};
    const storageResult = {
      readLastProjectedEventTimestamps: vi.fn().mockResolvedValue(),
    };
    const storage = vi.fn().mockResolvedValue(storageResult);
    const eventBus = vi.fn().mockResolvedValue();
    return initializeContext({}, { readModels, storage, eventBus }).then(
      (context) => {
        expect(context.backup).toBeUndefined();
      },
    );
  });

  test('build with backup wires backup into context', () => {
    const readModels = {};
    const storageResult = {
      readLastProjectedEventTimestamps: vi.fn().mockResolvedValue(),
    };
    const storage = vi.fn().mockResolvedValue(storageResult);
    const eventBus = vi.fn().mockResolvedValue();
    const backupInstance = { createBackup: vi.fn(), listBackups: vi.fn() };
    const backup = vi.fn().mockReturnValue(backupInstance);
    return initializeContext(
      {},
      { readModels, storage, eventBus, backup },
    ).then((context) => {
      expect(context.backup).toBe(backupInstance);
      expect(backup).toHaveBeenCalledWith(storageResult);
    });
  });

  test('concurrent connectEventBus calls result in single subscription', () => {
    const readModels = { rm1: {}, rm2: {} };
    const subscribeToEvents = vi.fn().mockResolvedValue();
    const storageResult = {
      readLastProjectedEventTimestamps: vi.fn().mockResolvedValue(),
    };
    const storage = vi.fn().mockResolvedValue(storageResult);
    const eventBus = vi.fn().mockImplementation((context) => {
      context.subscribeToEvents = subscribeToEvents;
      return Promise.resolve();
    });
    return initializeContext(
      {},
      { readModels, storage, eventBus, lifecycle: true },
    ).then((context) =>
      Promise.all([
        context.connectEventBus(),
        context.connectEventBus(),
        context.connectEventBus(),
      ]).then(() => {
        expect(subscribeToEvents).toHaveBeenCalledOnce();
      }),
    );
  });

  test('connectEventBus retries after failure', () => {
    const readModels = { rm1: {} };
    const subscribeToEvents = vi
      .fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce();
    const storageResult = {
      readLastProjectedEventTimestamps: vi.fn().mockResolvedValue(),
    };
    const storage = vi.fn().mockResolvedValue(storageResult);
    const eventBus = vi.fn().mockImplementation((context) => {
      context.subscribeToEvents = subscribeToEvents;
      return Promise.resolve();
    });
    return initializeContext(
      {},
      { readModels, storage, eventBus, lifecycle: true },
    ).then((context) =>
      context
        .connectEventBus()
        .then(
          () => {
            throw new Error('should not resolve');
          },
          () => context.connectEventBus(),
        )
        .then(() => {
          expect(subscribeToEvents).toHaveBeenCalledTimes(2);
        }),
    );
  });
});
