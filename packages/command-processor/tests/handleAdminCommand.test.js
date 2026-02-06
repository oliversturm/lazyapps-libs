import { describe, test, expect, vi } from 'vitest';
import { handleAdminCommand } from '../handleAdminCommand.js';

import { getLogger } from '@lazyapps/logger';

vi.mock('@lazyapps/logger', () => {
  const getLogger = vi.fn().mockReturnValue({
    debug: vi.fn(),
    error: vi.fn(),
  });
  return { getLogger };
});

describe('handleAdminCommand', () => {
  test('rejects unauthorized when skipAuthCheck is false', () => {
    const handler = handleAdminCommand(false);
    return handler({}, 'setReplayState', { state: true }, null, 'corr-1')
      .then(() => {
        throw new Error('should have rejected');
      })
      .catch((err) => {
        expect(err.message).toMatch(/Unauthorized/);
      });
  });

  test('rejects non-admin auth when skipAuthCheck is false', () => {
    const handler = handleAdminCommand(false);
    return handler(
      {},
      'setReplayState',
      { state: true },
      { admin: false },
      'corr-1',
    )
      .then(() => {
        throw new Error('should have rejected');
      })
      .catch((err) => {
        expect(err.message).toMatch(/Unauthorized/);
      });
  });

  test('allows admin auth', () => {
    const publishReplayState = vi.fn().mockReturnValue(vi.fn());
    const context = { eventBus: { publishReplayState } };
    const handler = handleAdminCommand(false);
    return handler(
      context,
      'setReplayState',
      { state: true },
      { admin: true },
      'corr-1',
    ).then(() => {
      expect(publishReplayState).toHaveBeenCalledWith('corr-1');
    });
  });

  test('skips auth check when skipAuthCheck is true', () => {
    const publishReplayState = vi.fn().mockReturnValue(vi.fn());
    const context = { eventBus: { publishReplayState } };
    const handler = handleAdminCommand(true);
    return handler(
      context,
      'setReplayState',
      { state: true },
      null,
      'corr-1',
    ).then(() => {
      expect(publishReplayState).toHaveBeenCalledWith('corr-1');
    });
  });

  test('rejects invalid admin command', () => {
    const handler = handleAdminCommand(true);
    return handler({}, 'invalidCommand', {}, null, 'corr-1')
      .then(() => {
        throw new Error('should have rejected');
      })
      .catch((err) => {
        expect(err.message).toMatch(/Invalid admin command/);
      });
  });

  test('rejects invalid replay state params', () => {
    const handler = handleAdminCommand(true);
    return handler(
      {},
      'setReplayState',
      { state: 'notboolean' },
      null,
      'corr-1',
    )
      .then(() => {
        throw new Error('should have rejected');
      })
      .catch((err) => {
        expect(err.message).toMatch(/Invalid replay state/);
      });
  });

  test('throws when no params provided', () => {
    const handler = handleAdminCommand(true);
    // Source accesses params.state in error message before rejecting,
    // so null params causes a TypeError
    expect(() =>
      handler({}, 'setReplayState', null, null, 'corr-1'),
    ).toThrow(TypeError);
  });

  test('rejects when eventBus is missing', () => {
    const handler = handleAdminCommand(true);
    return handler({}, 'setReplayState', { state: true }, null, 'corr-1')
      .then(() => {
        throw new Error('should have rejected');
      })
      .catch((err) => {
        expect(err.message).toMatch(/Event bus not found/);
      });
  });
});
