import { describe, test, expect, vi, afterEach, beforeEach } from 'vitest';
import { testing } from '../projections.js';

import { getLogger } from '@lazyapps/logger';

const {
  collectProjections,
  logProjections,
  updateInternalReadModelTimestamps,
  updateTimestamp,
  handleProjections,
  projectEvent,
} = testing;

vi.mock('@lazyapps/logger', () => {
  const getLogger = vi.fn().mockReturnValue({
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  });
  return { getLogger };
});

vi.mock('../tracing.js', () => ({
  withSpan: (name, attrs, fn) => fn(),
}));

vi.mock('@opentelemetry/api', () => ({
  metrics: {
    getMeter: () => ({
      createCounter: () => ({ add: vi.fn() }),
      createHistogram: () => ({ record: vi.fn() }),
    }),
  },
}));

describe('collectProjections', () => {
  let log;

  beforeEach(() => {
    log = getLogger();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test('find two', () => {
    const readModels = {
      rm1: {
        projections: {
          event1: () => 'projection result 1',
          event2: () => 'projection result 2',
        },
      },
      rm2: {
        projections: {
          event1: () => 'projection result 3',
          event2: () => 'projection result 4',
        },
      },
    };
    return collectProjections(readModels, {
      type: 'event1',
      timestamp: 4,
    }).then((projections) => {
      expect(projections).toBeDefined();
      expect(projections).toStrictEqual([
        ['rm1', readModels.rm1.projections.event1],
        ['rm2', readModels.rm2.projections.event1],
      ]);
    });
  });

  test('find none', () => {
    const readModels = {
      rm1: {
        projections: {
          event1: () => 'projection result 1',
          event2: () => 'projection result 2',
        },
      },
      rm2: {
        projections: {
          event1: () => 'projection result 3',
          event2: () => 'projection result 4',
        },
      },
    };
    return collectProjections(readModels, {
      type: 'event3',
      timestamp: 4,
    }).then((projections) => {
      expect(projections).toBeDefined();
      expect(projections).toStrictEqual([]);
    });
  });

  test('ignore read model without projections', () => {
    const readModels = {
      rm1: {
        projections: {
          event1: () => 'projection result 1',
          event2: () => 'projection result 2',
        },
      },
      rm2: {},
    };
    return collectProjections(readModels, {
      type: 'event1',
      timestamp: 4,
    }).then((projections) => {
      expect(projections).toBeDefined();
      expect(projections).toStrictEqual([
        ['rm1', readModels.rm1.projections.event1],
      ]);
    });
  });
});

describe('logProjections', () => {
  let log;

  beforeEach(() => {
    log = getLogger();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test('empty list', () => {
    const projs = [];
    expect(logProjections(log, false)(projs)).toBe(projs);
    expect(log.debug).toHaveBeenCalledTimes(0);
  });

  test('inReplay false', () => {
    const projs = [['rm1'], ['rm2']];
    expect(logProjections(log, false)(projs)).toBe(projs);
    expect(log.debug).toHaveBeenCalledWith(
      'Projecting event for read models: ["rm1","rm2"] (inReplay=false)',
    );
  });

  test('inReplay true', () => {
    const projs = [['rm1'], ['rm2']];
    expect(logProjections(log, true)(projs)).toBe(projs);
    expect(log.debug).toHaveBeenCalledWith(
      'Projecting event for read models: ["rm1","rm2"] (inReplay=true)',
    );
  });
});

describe('updateInternalReadModelTimestamps', () => {
  test('update', () => {
    const event = { type: 'event1', timestamp: 5 };
    const readModels = {
      rm1: { lastProjectedEventTimestamp: 3 },
      rm2: { lastProjectedEventTimestamp: 13 },
      rm3: { lastProjectedEventTimestamp: 99 },
    };

    const projections = [['rm1'], ['rm2']];
    return updateInternalReadModelTimestamps(
      event,
      readModels,
    )(projections).then((projs) => {
      expect(projs).toBe(projections);
      expect(readModels.rm1.lastProjectedEventTimestamp).toEqual(5);
      // this value has been changed downwards
      // that's the implementation - probably
      // shouldn't normally happen, but let's
      // document it for now
      expect(readModels.rm2.lastProjectedEventTimestamp).toEqual(5);
      // this one is untouched
      expect(readModels.rm3.lastProjectedEventTimestamp).toEqual(99);
    });
  });
});

describe('updateTimestamp', () => {
  test('update', () => {
    const storage = {
      updateLastProjectedEventTimestamps: vi.fn().mockResolvedValue(),
    };
    return updateTimestamp('correlation', storage, 'rm1', 99).then(() => {
      // any result we receive is irrelevant and depends on what the
      // read model projection does
      expect(storage.updateLastProjectedEventTimestamps).toHaveBeenCalledWith(
        'correlation',
        ['rm1'],
        99,
      );
    });
  });
});

describe('handleProjections', () => {
  let log;

  beforeEach(() => {
    log = getLogger();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const projContext = {};
  const getProjectionContext = () => () => vi.fn().mockReturnValue(projContext);
  const context = {
    storage: {
      updateLastProjectedEventTimestamps: vi.fn().mockResolvedValue(),
    },
  };
  const event = { timestamp: 10 };

  test('all good', () => {
    const f1 = vi.fn().mockResolvedValue();
    const f2 = vi.fn().mockResolvedValue();
    const projections = [
      ['rm1', f1],
      ['rm2', f2],
    ];
    return handleProjections(
      'correlation',
      log,
      context,
      getProjectionContext,
      false,
      event,
    )(projections).then((res) => {
      expect(res).toSatisfy((r) => Array.isArray(r));
      expect(res.length).toBe(2);
      // the results themselves have no meanings

      expect(f1).toHaveBeenCalledOnce();
      expect(f2).toHaveBeenCalledOnce();

      expect(log.error).toHaveBeenCalledTimes(0);
    });
  });

  test('one good, one error', () => {
    const f1 = vi.fn().mockRejectedValue();
    const f2 = vi.fn().mockResolvedValue();
    const projections = [
      ['rm1', f1],
      ['rm2', f2],
    ];
    return handleProjections(
      'correlation',
      log,
      context,
      getProjectionContext,
      false,
      event,
    )(projections).then((res) => {
      expect(res).toSatisfy((r) => Array.isArray(r));
      expect(res.length).toBe(2);
      // the results themselves have no meanings

      expect(f1).toHaveBeenCalledOnce();
      expect(f2).toHaveBeenCalledOnce();

      expect(log.error).toHaveBeenCalledTimes(1);
    });
  });
});

describe('projectEvent with encryptionDecryptor', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test('calls decryptor before collecting projections', () => {
    const decryptedEvent = {
      type: 'TEST',
      timestamp: 1,
      payload: { name: 'decrypted' },
    };
    const encryptionDecryptor = vi.fn().mockResolvedValue(decryptedEvent);
    const projectionFn = vi.fn().mockResolvedValue();
    const context = {
      encryptionDecryptor,
      readModels: {
        testRM: {
          projections: { TEST: projectionFn },
          lastProjectedEventTimestamp: 0,
        },
      },
      storage: {
        updateLastProjectedEventTimestamps: vi.fn().mockResolvedValue(),
      },
    };

    const eventQueue = { add: (fn) => fn() };
    const projCtx = {};
    const getProjectionContext = () => () => () => projCtx;

    const encryptedEvent = {
      type: 'TEST',
      timestamp: 1,
      payload: { name: 'encrypted-blob' },
    };

    return projectEvent(
      context,
      eventQueue,
      getProjectionContext,
    )('corr')(encryptedEvent, false).then(() => {
      expect(encryptionDecryptor).toHaveBeenCalledWith(encryptedEvent);
      expect(projectionFn).toHaveBeenCalledWith(projCtx, decryptedEvent);
    });
  });

  test('defaults to identity when no decryptor provided', () => {
    const projectionFn = vi.fn().mockResolvedValue();
    const context = {
      readModels: {
        testRM: {
          projections: { TEST: projectionFn },
          lastProjectedEventTimestamp: 0,
        },
      },
      storage: {
        updateLastProjectedEventTimestamps: vi.fn().mockResolvedValue(),
      },
    };

    const eventQueue = { add: (fn) => fn() };
    const projCtx = {};
    const getProjectionContext = () => () => () => projCtx;

    const event = { type: 'TEST', timestamp: 1, payload: { name: 'Alice' } };

    return projectEvent(
      context,
      eventQueue,
      getProjectionContext,
    )('corr')(event, false).then(() => {
      expect(projectionFn).toHaveBeenCalledWith(projCtx, event);
    });
  });
});

describe('projectEvent SUBJECT_FORGOTTEN auto-detection', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test('calls encryptionForgetSubjectContext when SUBJECT_FORGOTTEN event arrives with contexts', () => {
    const encryptionForgetSubjectContext = vi.fn().mockResolvedValue();
    const projectionFn = vi.fn().mockResolvedValue();
    const context = {
      encryptionForgetSubjectContext,
      readModels: {
        testRM: {
          projections: { SUBJECT_FORGOTTEN: projectionFn },
          lastProjectedEventTimestamp: 0,
        },
      },
      storage: {
        updateLastProjectedEventTimestamps: vi.fn().mockResolvedValue(),
      },
    };

    const eventQueue = { add: (fn) => fn() };
    const projCtx = {};
    const getProjectionContext = () => () => () => projCtx;

    const event = {
      type: 'SUBJECT_FORGOTTEN',
      timestamp: 1,
      payload: { subjectId: 'cust-42', contexts: ['personal'] },
    };

    return projectEvent(
      context,
      eventQueue,
      getProjectionContext,
    )('corr')(event, false).then(() => {
      expect(encryptionForgetSubjectContext).toHaveBeenCalledWith(
        'cust-42',
        'personal',
      );
      expect(projectionFn).toHaveBeenCalledWith(projCtx, event);
    });
  });

  test('does not call encryptionForgetSubjectContext for non-forget events', () => {
    const encryptionForgetSubjectContext = vi.fn().mockResolvedValue();
    const projectionFn = vi.fn().mockResolvedValue();
    const context = {
      encryptionForgetSubjectContext,
      readModels: {
        testRM: {
          projections: { CUSTOMER_CREATED: projectionFn },
          lastProjectedEventTimestamp: 0,
        },
      },
      storage: {
        updateLastProjectedEventTimestamps: vi.fn().mockResolvedValue(),
      },
    };

    const eventQueue = { add: (fn) => fn() };
    const projCtx = {};
    const getProjectionContext = () => () => () => projCtx;

    const event = {
      type: 'CUSTOMER_CREATED',
      timestamp: 1,
      payload: { name: 'Alice' },
    };

    return projectEvent(
      context,
      eventQueue,
      getProjectionContext,
    )('corr')(event, false).then(() => {
      expect(encryptionForgetSubjectContext).not.toHaveBeenCalled();
      expect(projectionFn).toHaveBeenCalledWith(projCtx, event);
    });
  });

  test('skips shredding when SUBJECT_FORGOTTEN has no contexts in payload', () => {
    const encryptionForgetSubjectContext = vi.fn().mockResolvedValue();
    const projectionFn = vi.fn().mockResolvedValue();
    const context = {
      encryptionForgetSubjectContext,
      readModels: {
        testRM: {
          projections: { SUBJECT_FORGOTTEN: projectionFn },
          lastProjectedEventTimestamp: 0,
        },
      },
      storage: {
        updateLastProjectedEventTimestamps: vi.fn().mockResolvedValue(),
      },
    };

    const eventQueue = { add: (fn) => fn() };
    const projCtx = {};
    const getProjectionContext = () => () => () => projCtx;

    const event = {
      type: 'SUBJECT_FORGOTTEN',
      timestamp: 1,
      payload: { subjectId: 'cust-42' },
    };

    return projectEvent(
      context,
      eventQueue,
      getProjectionContext,
    )('corr')(event, false).then(() => {
      expect(encryptionForgetSubjectContext).not.toHaveBeenCalled();
      expect(projectionFn).toHaveBeenCalledWith(projCtx, event);
    });
  });

  test('skips shredding when encryptionForgetSubjectContext is not configured', () => {
    const projectionFn = vi.fn().mockResolvedValue();
    const context = {
      readModels: {
        testRM: {
          projections: { SUBJECT_FORGOTTEN: projectionFn },
          lastProjectedEventTimestamp: 0,
        },
      },
      storage: {
        updateLastProjectedEventTimestamps: vi.fn().mockResolvedValue(),
      },
    };

    const eventQueue = { add: (fn) => fn() };
    const projCtx = {};
    const getProjectionContext = () => () => () => projCtx;

    const event = {
      type: 'SUBJECT_FORGOTTEN',
      timestamp: 1,
      payload: { subjectId: 'cust-42' },
    };

    return projectEvent(
      context,
      eventQueue,
      getProjectionContext,
    )('corr')(event, false).then(() => {
      expect(projectionFn).toHaveBeenCalledWith(projCtx, event);
    });
  });

  test('calls forgetSubjectContext before projection handler runs', () => {
    const callOrder = [];
    const encryptionForgetSubjectContext = vi.fn().mockImplementation(() => {
      callOrder.push('forgetSubjectContext');
      return Promise.resolve();
    });
    const projectionFn = vi.fn().mockImplementation(() => {
      callOrder.push('projection');
      return Promise.resolve();
    });
    const context = {
      encryptionForgetSubjectContext,
      readModels: {
        testRM: {
          projections: { SUBJECT_FORGOTTEN: projectionFn },
          lastProjectedEventTimestamp: 0,
        },
      },
      storage: {
        updateLastProjectedEventTimestamps: vi.fn().mockResolvedValue(),
      },
    };

    const eventQueue = { add: (fn) => fn() };
    const projCtx = {};
    const getProjectionContext = () => () => () => projCtx;

    const event = {
      type: 'SUBJECT_FORGOTTEN',
      timestamp: 1,
      payload: { subjectId: 'cust-42', contexts: ['personal'] },
    };

    return projectEvent(
      context,
      eventQueue,
      getProjectionContext,
    )('corr')(event, false).then(() => {
      expect(callOrder).toEqual(['forgetSubjectContext', 'projection']);
    });
  });
});
