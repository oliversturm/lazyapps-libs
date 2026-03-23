import { describe, test, expect, vi } from 'vitest';
import { handleAdminCommand } from '../handleAdminCommand.js';
import { AuthorizationError } from '../validation.js';

vi.mock('@lazyapps/logger', () => {
  const getLogger = vi.fn().mockReturnValue({
    debug: vi.fn(),
    error: vi.fn(),
  });
  return { getLogger };
});

const isAdmin = (auth) => auth && auth.roles && auth.roles.includes('admin');

describe('handleAdminCommand', () => {
  test('rejects with AuthorizationError when no isAdmin callback configured', () => {
    const handler = handleAdminCommand(undefined);
    return handler({}, 'setReplayState', { state: true }, null, 'corr-1')
      .then(() => {
        throw new Error('should have rejected');
      })
      .catch((err) => {
        expect(err).toBeInstanceOf(AuthorizationError);
        expect(err.message).toMatch(/not configured/);
      });
  });

  test('rejects with AuthorizationError when isAdmin returns false', () => {
    const handler = handleAdminCommand(isAdmin);
    return handler(
      {},
      'setReplayState',
      { state: true },
      { roles: ['user'] },
      'corr-1',
    )
      .then(() => {
        throw new Error('should have rejected');
      })
      .catch((err) => {
        expect(err).toBeInstanceOf(AuthorizationError);
        expect(err.message).toMatch(/Admin role required/);
      });
  });

  test('rejects with AuthorizationError when auth is null', () => {
    const handler = handleAdminCommand(isAdmin);
    return handler({}, 'setReplayState', { state: true }, null, 'corr-1')
      .then(() => {
        throw new Error('should have rejected');
      })
      .catch((err) => {
        expect(err).toBeInstanceOf(AuthorizationError);
      });
  });

  test('allows when isAdmin returns true', () => {
    const publishReplayState = vi.fn().mockReturnValue(vi.fn());
    const context = { eventBus: { publishReplayState } };
    const handler = handleAdminCommand(isAdmin);
    return handler(
      context,
      'setReplayState',
      { state: true },
      { roles: ['admin'] },
      'corr-1',
    ).then(() => {
      expect(publishReplayState).toHaveBeenCalledWith('corr-1');
    });
  });

  test('rejects invalid admin command', () => {
    const handler = handleAdminCommand(isAdmin);
    return handler({}, 'invalidCommand', {}, { roles: ['admin'] }, 'corr-1')
      .then(() => {
        throw new Error('should have rejected');
      })
      .catch((err) => {
        expect(err.message).toMatch(/Invalid admin command/);
      });
  });

  test('rejects invalid replay state params', () => {
    const handler = handleAdminCommand(isAdmin);
    return handler(
      {},
      'setReplayState',
      { state: 'notboolean' },
      { roles: ['admin'] },
      'corr-1',
    )
      .then(() => {
        throw new Error('should have rejected');
      })
      .catch((err) => {
        expect(err.message).toMatch(/Invalid replay state/);
      });
  });

  test('rejects when eventBus is missing', () => {
    const handler = handleAdminCommand(isAdmin);
    return handler(
      {},
      'setReplayState',
      { state: true },
      { roles: ['admin'] },
      'corr-1',
    )
      .then(() => {
        throw new Error('should have rejected');
      })
      .catch((err) => {
        expect(err.message).toMatch(/Event bus not found/);
      });
  });
});
