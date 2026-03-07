import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('@lazyapps/logger', () => ({
  getLogger: vi.fn().mockReturnValue({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { createCatchupHandler, __testing__ } =
  await import('../catchupHandler.js');
const { isDuplicate } = __testing__;

describe('isDuplicate', () => {
  test('returns true when event timestamp is below lastCatchupTimestamp', () => {
    const event = { timestamp: 100, type: 'A', aggregateId: '1' };
    const state = {
      lastCatchupTimestamp: 200,
      catchupEventFingerprints: new Set(),
    };
    expect(isDuplicate(event, state, 200)).toBe(true);
  });

  test('returns true for fingerprint match at boundary timestamp', () => {
    const event = { timestamp: 200, type: 'A', aggregateId: '1' };
    const state = {
      lastCatchupTimestamp: 200,
      catchupEventFingerprints: new Set(['200:A:1']),
    };
    expect(isDuplicate(event, state, 200)).toBe(true);
  });

  test('returns false for non-matching fingerprint at boundary timestamp', () => {
    const event = { timestamp: 200, type: 'B', aggregateId: '2' };
    const state = {
      lastCatchupTimestamp: 200,
      catchupEventFingerprints: new Set(['200:A:1']),
    };
    expect(isDuplicate(event, state, 200)).toBe(false);
  });

  test('returns false when event timestamp is above lastCatchupTimestamp', () => {
    const event = { timestamp: 300, type: 'A', aggregateId: '1' };
    const state = {
      lastCatchupTimestamp: 200,
      catchupEventFingerprints: new Set(),
    };
    expect(isDuplicate(event, state, 200)).toBe(false);
  });
});

describe('catchupHandler', () => {
  let context;

  beforeEach(() => {
    vi.clearAllMocks();
    context = {
      projectionHandler: {
        getCatchupState: vi.fn(),
        clearCatchupState: vi.fn(),
        projectCatchupEventForReadModel: vi.fn(),
      },
      lifecycleManager: {
        setState: vi.fn(),
      },
    };
  });

  describe('handleCatchupComplete', () => {
    test('transitions to live when FIFO queue is empty', () => {
      context.projectionHandler.getCatchupState.mockReturnValue({
        active: true,
        fifoQueue: [],
        catchupEventFingerprints: new Set(),
        lastCatchupTimestamp: 100,
      });

      const handler = createCatchupHandler(context);

      return handler.handleCatchupComplete('customers', 100).then(() => {
        expect(
          context.projectionHandler.clearCatchupState,
        ).toHaveBeenCalledWith('customers');
        expect(context.lifecycleManager.setState).toHaveBeenCalledWith(
          'customers',
          'live',
        );
      });
    });

    test('drains FIFO queue in order', () => {
      const projectedEvents = [];
      context.projectionHandler.getCatchupState.mockReturnValue({
        active: true,
        fifoQueue: [
          {
            correlationId: 'c1',
            event: { timestamp: 201, type: 'A', aggregateId: '1' },
          },
          {
            correlationId: 'c2',
            event: { timestamp: 202, type: 'B', aggregateId: '2' },
          },
          {
            correlationId: 'c3',
            event: { timestamp: 203, type: 'C', aggregateId: '3' },
          },
        ],
        catchupEventFingerprints: new Set(),
        lastCatchupTimestamp: 200,
      });

      context.projectionHandler.projectCatchupEventForReadModel.mockImplementation(
        (correlationId, readModel) => (event) => {
          projectedEvents.push({ correlationId, event });
          return Promise.resolve();
        },
      );

      const handler = createCatchupHandler(context);

      return handler.handleCatchupComplete('customers', 200).then(() => {
        expect(projectedEvents).toHaveLength(3);
        expect(projectedEvents[0].event.type).toBe('A');
        expect(projectedEvents[1].event.type).toBe('B');
        expect(projectedEvents[2].event.type).toBe('C');
        expect(projectedEvents[0].correlationId).toBe('c1');
        expect(context.lifecycleManager.setState).toHaveBeenCalledWith(
          'customers',
          'live',
        );
      });
    });

    test('deduplicates events with timestamp below lastCatchupTimestamp', () => {
      const projectedEvents = [];
      context.projectionHandler.getCatchupState.mockReturnValue({
        active: true,
        fifoQueue: [
          {
            correlationId: 'c1',
            event: { timestamp: 100, type: 'A', aggregateId: '1' },
          },
          {
            correlationId: 'c2',
            event: { timestamp: 201, type: 'B', aggregateId: '2' },
          },
        ],
        catchupEventFingerprints: new Set(),
        lastCatchupTimestamp: 200,
      });

      context.projectionHandler.projectCatchupEventForReadModel.mockImplementation(
        (correlationId, readModel) => (event) => {
          projectedEvents.push(event);
          return Promise.resolve();
        },
      );

      const handler = createCatchupHandler(context);

      return handler.handleCatchupComplete('customers', 200).then(() => {
        expect(projectedEvents).toHaveLength(1);
        expect(projectedEvents[0].type).toBe('B');
      });
    });

    test('deduplicates events at boundary by fingerprint', () => {
      const projectedEvents = [];
      context.projectionHandler.getCatchupState.mockReturnValue({
        active: true,
        fifoQueue: [
          {
            correlationId: 'c1',
            event: { timestamp: 200, type: 'A', aggregateId: '1' },
          },
          {
            correlationId: 'c2',
            event: { timestamp: 200, type: 'B', aggregateId: '2' },
          },
        ],
        catchupEventFingerprints: new Set(['200:A:1']),
        lastCatchupTimestamp: 200,
      });

      context.projectionHandler.projectCatchupEventForReadModel.mockImplementation(
        (correlationId, readModel) => (event) => {
          projectedEvents.push(event);
          return Promise.resolve();
        },
      );

      const handler = createCatchupHandler(context);

      return handler.handleCatchupComplete('customers', 200).then(() => {
        expect(projectedEvents).toHaveLength(1);
        expect(projectedEvents[0].type).toBe('B');
      });
    });

    test('resolves when no catch-up state found', () => {
      context.projectionHandler.getCatchupState.mockReturnValue(null);

      const handler = createCatchupHandler(context);

      return handler.handleCatchupComplete('customers', 100).then(() => {
        expect(
          context.projectionHandler.clearCatchupState,
        ).not.toHaveBeenCalled();
        expect(context.lifecycleManager.setState).not.toHaveBeenCalled();
      });
    });
  });

  describe('handleCatchupCancelled', () => {
    test('clears state and reverts to waiting', () => {
      const handler = createCatchupHandler(context);

      handler.handleCatchupCancelled('customers');

      expect(context.projectionHandler.clearCatchupState).toHaveBeenCalledWith(
        'customers',
      );
      expect(context.lifecycleManager.setState).toHaveBeenCalledWith(
        'customers',
        'waiting',
      );
    });
  });
});
