import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@lazyapps/logger', () => {
  const getLogger = vi.fn().mockReturnValue({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  });
  return { getLogger };
});

const mockWriteCallback = vi.fn();
const mockEndCallback = vi.fn();
const mockWriteStream = {
  fd: 1,
  on: vi.fn(),
  write: vi.fn().mockImplementation((data, cb) => {
    mockWriteCallback(data);
    cb(null);
  }),
  end: vi.fn().mockImplementation((cb) => {
    mockEndCallback();
    cb(null);
  }),
};

vi.mock('fs', () => ({
  createWriteStream: vi.fn().mockReturnValue(mockWriteStream),
  fsyncSync: vi.fn(),
}));

// Dynamic import after mocks are set up
const { createCommandRecorder } = await import('../commandRecorder.js');

describe('createCommandRecorder', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-set default implementations after clearing
    mockWriteStream.write.mockImplementation((data, cb) => {
      mockWriteCallback(data);
      cb(null);
    });
    mockWriteStream.end.mockImplementation((cb) => {
      mockEndCallback();
      cb(null);
    });
  });

  test('recordCommand writes JSON to stream', () => {
    const recorder = createCommandRecorder('/tmp/test-commands.jsonl');
    const record = {
      command: 'CREATE',
      aggregateName: 'thing',
      aggregateId: 'id-1',
      correlationId: 'corr-1',
    };
    return recorder.recordCommand(record).then((result) => {
      expect(result).toEqual(record);
      expect(mockWriteCallback).toHaveBeenCalledWith(
        JSON.stringify(record) + '\n',
      );
    });
  });

  test('recordCommand rejects on write error', () => {
    const recorder = createCommandRecorder('/tmp/test-commands.jsonl');
    mockWriteStream.write.mockImplementationOnce((data, cb) => {
      cb(new Error('write failed'));
    });
    const record = {
      command: 'CREATE',
      correlationId: 'corr-1',
    };
    return recorder
      .recordCommand(record)
      .then(() => {
        throw new Error('should have rejected');
      })
      .catch((err) => {
        expect(err.message).toBe('write failed');
      });
  });

  test('close ends the write stream', () => {
    const recorder = createCommandRecorder('/tmp/test-commands.jsonl');
    return recorder.close().then(() => {
      expect(mockWriteStream.end).toHaveBeenCalledOnce();
    });
  });

  test('close rejects on end error', () => {
    const recorder = createCommandRecorder('/tmp/test-commands.jsonl');
    mockWriteStream.end.mockImplementationOnce((cb) => {
      cb(new Error('close failed'));
    });
    return recorder
      .close()
      .then(() => {
        throw new Error('should have rejected');
      })
      .catch((err) => {
        expect(err.message).toBe('close failed');
      });
  });
});
