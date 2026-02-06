import { describe, test, expect, vi } from 'vitest';
import { createChangeNotificationHandler } from '../changeNotification.js';

vi.mock('@lazyapps/logger', () => {
  const getLogger = vi.fn().mockReturnValue({
    debug: vi.fn(),
    error: vi.fn(),
  });
  return { getLogger };
});

describe('createChangeNotificationHandler', () => {
  test('sendChangeNotification calls sender', () => {
    const sender = {
      sendChangeNotification: vi.fn().mockResolvedValue('sent'),
    };
    const handler = createChangeNotificationHandler(sender)('corr-1');
    const changeInfo = { readModelName: 'items', changeKind: 'all' };

    return handler.sendChangeNotification(changeInfo).then(() => {
      expect(sender.sendChangeNotification).toHaveBeenCalledWith(
        'corr-1',
        changeInfo,
      );
    });
  });

  test('sendChangeNotification catches sender errors', () => {
    const sender = {
      sendChangeNotification: vi
        .fn()
        .mockRejectedValue(new Error('send failed')),
    };
    const handler = createChangeNotificationHandler(sender)('corr-1');
    const changeInfo = { readModelName: 'items' };

    // Should not throw - errors are caught internally
    return handler.sendChangeNotification(changeInfo);
  });

  test('createChangeInfo returns correct structure', () => {
    const sender = { sendChangeNotification: vi.fn() };
    const handler = createChangeNotificationHandler(sender)('corr-1');

    const info = handler.createChangeInfo(
      'endpoint1',
      'items',
      'all',
      'addRow',
      { id: '123' },
    );
    expect(info).toEqual({
      endpointName: 'endpoint1',
      readModelName: 'items',
      resolverName: 'all',
      changeKind: 'addRow',
      details: { id: '123' },
    });
  });

  test('createChangeInfo works with any changeKind', () => {
    const sender = { sendChangeNotification: vi.fn() };
    const handler = createChangeNotificationHandler(sender)('corr-1');

    const info = handler.createChangeInfo(
      'ep',
      'rm',
      'resolver',
      'customKind',
      null,
    );
    expect(info.changeKind).toBe('customKind');
    expect(info.details).toBeNull();
  });
});
