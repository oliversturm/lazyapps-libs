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

  test('schedule passes correlationId to promiseGenerator', () => {
    return createSideEffectsHandler().then((result) => {
      const handler = result.getSideEffectsHandler('corr-1', false);
      const generator = vi.fn(() => Promise.resolve());
      return handler.schedule(generator, { name: 'test-effect' }).then(() => {
        expect(generator).toHaveBeenCalledWith('corr-1');
      });
    });
  });

  test('schedule runs liveOnly side-effect when not in replay', () => {
    return createSideEffectsHandler().then((result) => {
      const handler = result.getSideEffectsHandler('corr-1', false);
      const effect = vi.fn().mockResolvedValue();
      return handler
        .schedule(() => effect(), {
          name: 'test-effect',
          execution: 'liveOnly',
        })
        .then(() => {
          expect(effect).toHaveBeenCalledOnce();
        });
    });
  });

  test('schedule skips liveOnly side-effect when in replay', () => {
    return createSideEffectsHandler().then((result) => {
      const handler = result.getSideEffectsHandler('corr-1', true);
      const effect = vi.fn().mockResolvedValue();
      return handler
        .schedule(() => effect(), {
          name: 'test-effect',
          execution: 'liveOnly',
        })
        .then(() => {
          expect(effect).not.toHaveBeenCalled();
        });
    });
  });

  test('schedule runs replayOnly side-effect when in replay', () => {
    return createSideEffectsHandler().then((result) => {
      const handler = result.getSideEffectsHandler('corr-1', true);
      const effect = vi.fn().mockResolvedValue();
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

  test('schedule skips replayOnly side-effect when not in replay', () => {
    return createSideEffectsHandler().then((result) => {
      const handler = result.getSideEffectsHandler('corr-1', false);
      const effect = vi.fn().mockResolvedValue();
      return handler
        .schedule(() => effect(), {
          name: 'test-effect',
          execution: 'replayOnly',
        })
        .then(() => {
          expect(effect).not.toHaveBeenCalled();
        });
    });
  });

  test('schedule runs always side-effect when in replay', () => {
    return createSideEffectsHandler().then((result) => {
      const handler = result.getSideEffectsHandler('corr-1', true);
      const effect = vi.fn().mockResolvedValue();
      return handler
        .schedule(() => effect(), { name: 'test-effect', execution: 'always' })
        .then(() => {
          expect(effect).toHaveBeenCalledOnce();
        });
    });
  });

  test('schedule runs always side-effect when not in replay', () => {
    return createSideEffectsHandler().then((result) => {
      const handler = result.getSideEffectsHandler('corr-1', false);
      const effect = vi.fn().mockResolvedValue();
      return handler
        .schedule(() => effect(), { name: 'test-effect', execution: 'always' })
        .then(() => {
          expect(effect).toHaveBeenCalledOnce();
        });
    });
  });

  test('schedule defaults to liveOnly execution', () => {
    return createSideEffectsHandler().then((result) => {
      const handler = result.getSideEffectsHandler('corr-1', true);
      const effect = vi.fn().mockResolvedValue();
      return handler
        .schedule(() => effect())
        .then(() => {
          // Default execution is 'liveOnly', should skip in replay
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
});
