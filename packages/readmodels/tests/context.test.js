import { describe, test, expect, vi } from 'vitest';
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
});
