import { describe, test, expect, vi } from 'vitest';
import { createSideEffectsHandler } from '../sideEffects.js';

vi.mock('@lazyapps/logger', () => {
  const getLogger = vi.fn().mockReturnValue({
    debug: vi.fn(),
    error: vi.fn(),
  });
  return { getLogger };
});

describe('createSideEffectsHandler', () => {
  test('returns a promise with getSideEffectsHandler', () => {
    return createSideEffectsHandler().then((result) => {
      expect(result.getSideEffectsHandler).toBeDefined();
      expect(typeof result.getSideEffectsHandler).toBe('function');
    });
  });

  test('getSideEffectsHandler returns object with schedule', () => {
    return createSideEffectsHandler().then((result) => {
      const handler = result.getSideEffectsHandler('corr-1', false);
      expect(handler.schedule).toBeDefined();
      expect(typeof handler.schedule).toBe('function');
    });
  });

  test('schedule runs side-effect when not in replay', () => {
    return createSideEffectsHandler().then((result) => {
      const handler = result.getSideEffectsHandler('corr-1', false);
      const effect = vi.fn().mockResolvedValue();
      return handler
        .schedule(() => effect(), { name: 'test-effect' })
        .then(() => {
          expect(effect).toHaveBeenCalledOnce();
        });
    });
  });

  test('schedule skips side-effect when in replay', () => {
    return createSideEffectsHandler().then((result) => {
      const handler = result.getSideEffectsHandler('corr-1', true);
      const effect = vi.fn().mockResolvedValue();
      return handler
        .schedule(() => effect(), { name: 'test-effect' })
        .then(() => {
          expect(effect).not.toHaveBeenCalled();
        });
    });
  });

  test('schedule skips side-effect when in replay even without options', () => {
    return createSideEffectsHandler().then((result) => {
      const handler = result.getSideEffectsHandler('corr-1', true);
      const effect = vi.fn().mockResolvedValue();
      return handler
        .schedule(() => effect())
        .then(() => {
          expect(effect).not.toHaveBeenCalled();
        });
    });
  });

  test('schedule catches errors from side-effect', () => {
    return createSideEffectsHandler().then((result) => {
      const handler = result.getSideEffectsHandler('corr-1', false);
      const effect = vi.fn().mockRejectedValue(new Error('effect failed'));
      // Should not throw - errors are caught internally
      return handler.schedule(() => effect(), { name: 'failing-effect' });
    });
  });

  // 13.3: execution parameter was removed — passing it has no effect
  test('13.3: execution option is silently ignored (removed parameter)', () => {
    return createSideEffectsHandler().then((result) => {
      const handler = result.getSideEffectsHandler('corr-1', false);
      const effect = vi.fn().mockResolvedValue();

      // Passing execution: 'replayOnly' should be ignored — effect still runs
      return handler
        .schedule(() => effect(), {
          name: 'test-effect',
          execution: 'replayOnly',
        })
        .then(() => {
          expect(effect).toHaveBeenCalledOnce();
        });
    });
  });

  test('13.3: execution: always is silently ignored — replay still skips', () => {
    return createSideEffectsHandler().then((result) => {
      // inReplay=true — effects should be skipped regardless of execution option
      const handler = result.getSideEffectsHandler('corr-1', true);
      const effect = vi.fn().mockResolvedValue();

      return handler
        .schedule(() => effect(), {
          name: 'test-effect',
          execution: 'always',
        })
        .then(() => {
          // execution: 'always' has no effect — still skipped during replay
          expect(effect).not.toHaveBeenCalled();
        });
    });
  });
});
