import { describe, test, expect, vi } from 'vitest';
import { createCommandHandler } from '../commands.js';

vi.mock('@lazyapps/logger', () => {
  const getLogger = vi.fn().mockReturnValue({
    debug: vi.fn(),
    error: vi.fn(),
  });
  return { getLogger };
});

describe('createCommandHandler', () => {
  test('execute sends command via commandSender', () => {
    const commandSender = {
      sendCommand: vi.fn().mockResolvedValue('sent'),
    };
    const handler = createCommandHandler({ commandSender })('corr-1');
    const cmd = { aggregateName: 'thing', command: 'CREATE' };

    return handler.execute(cmd)().then(() => {
      expect(commandSender.sendCommand).toHaveBeenCalledWith('corr-1', cmd);
    });
  });

  test('execute returns a lazy function', () => {
    const commandSender = {
      sendCommand: vi.fn().mockResolvedValue('sent'),
    };
    const handler = createCommandHandler({ commandSender })('corr-1');
    const cmd = { command: 'CREATE' };

    const lazyFn = handler.execute(cmd);
    expect(typeof lazyFn).toBe('function');
    expect(commandSender.sendCommand).not.toHaveBeenCalled();
  });

  test('execute catches errors from commandSender', () => {
    const commandSender = {
      sendCommand: vi.fn().mockRejectedValue(new Error('send failed')),
    };
    const handler = createCommandHandler({ commandSender })('corr-1');
    const cmd = { command: 'CREATE' };

    // Should not throw - errors are caught internally
    return handler.execute(cmd)();
  });
});
