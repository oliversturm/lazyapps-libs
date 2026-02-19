import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { inmemory } from '..';

import { getLogger } from '@lazyapps/logger';

vi.mock('@lazyapps/logger', () => {
  const getLogger = vi.fn().mockReturnValue({
    debug: vi.fn(),
    warn: vi.fn(),
  });
  return { getLogger };
});

const aggregates = {
  thing: {
    initial: () => {
      flag: 'initial';
    },
    projections: {
      CREATED: (/*state, event*/) => ({ flag: 'created' }),
    },
  },
};

describe('applyAggregateProjection', () => {
  let log;

  beforeEach(() => {
    log = getLogger();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test('apply, no trouble', () => {
    const store = inmemory()(aggregates);
    const event = {
      aggregateName: 'thing',
      aggregateId: 'id-1',
      type: 'CREATED',
      timestamp: 55,
    };
    expect(store.applyAggregateProjection('correlation')(event)).toEqual(event);

    // Not the cleanest stuff to test, but it confirms
    // the algorithm does what it should. For now.
    expect(log.debug).toBeCalledTimes(1);
    expect(log.warn).toBeCalledTimes(0);
    expect(store.getAggregateState('thing', 'id-1')).toEqual({
      flag: 'created',
    });
  });

  test('no aggregate projection type', () => {
    const store = inmemory()(aggregates);
    const event = {
      aggregateName: 'thing',
      aggregateId: 'id-1',
      type: 'DOMAGIC',
      timestamp: 55,
    };
    expect(store.applyAggregateProjection('correlation')(event)).toEqual(event);

    // Not the cleanest stuff to test, but it confirms
    // the algorithm does what it should. For now.
    expect(log.debug).toBeCalledTimes(1);
    expect(log.warn).toBeCalledTimes(0);
    expect(store.getAggregateState('thing', 'id-1')).toBeUndefined();
  });

  test('event out of sequence', () => {
    const store = inmemory()(aggregates);
    const event1 = {
      aggregateName: 'thing',
      aggregateId: 'id-1',
      type: 'CREATED',
      timestamp: 55,
    };
    store.applyAggregateProjection('correlation')(event1);
    const event2 = {
      aggregateName: 'thing',
      aggregateId: 'id-2',
      type: 'CREATED',
      timestamp: 33,
    };
    store.applyAggregateProjection('correlation')(event2);
    expect(log.debug).toBeCalledTimes(3); // 1 for event1, 2 for event 2 (projection + out of sequence notice)
  });

  test('random event order allowed in replay', () => {
    const store = inmemory()(aggregates);
    const event1 = {
      aggregateName: 'thing',
      aggregateId: 'id-1',
      type: 'CREATED',
      timestamp: 55,
    };
    store.applyAggregateProjection('correlation')(event1);
    const event2 = {
      aggregateName: 'thing',
      aggregateId: 'id-2',
      type: 'CREATED',
      timestamp: 33,
    };
    store.startReplay();
    store.applyAggregateProjection('correlation')(event2);
  });
});

describe('forgetSubject', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test('removes subject state across all aggregate names', () => {
    const thingInitial = { flag: 'thing-initial' };
    const otherInitial = { flag: 'other-initial' };
    const multiAggregates = {
      thing: {
        initial: () => thingInitial,
        projections: {
          CREATED: () => ({ flag: 'created' }),
        },
      },
      other: {
        initial: () => otherInitial,
        projections: {
          CREATED: () => ({ flag: 'other-created' }),
        },
      },
    };
    const store = inmemory()(multiAggregates);

    store.applyAggregateProjection('c')({
      aggregateName: 'thing',
      aggregateId: 'id-1',
      type: 'CREATED',
      timestamp: 1,
    });
    store.applyAggregateProjection('c')({
      aggregateName: 'other',
      aggregateId: 'id-1',
      type: 'CREATED',
      timestamp: 2,
    });

    expect(store.getAggregateState('thing', 'id-1')).toEqual({
      flag: 'created',
    });
    expect(store.getAggregateState('other', 'id-1')).toEqual({
      flag: 'other-created',
    });

    return store.forgetSubject('id-1').then(() => {
      // After forget, getAggregateState returns the initial state
      expect(store.getAggregateState('thing', 'id-1')).toEqual(thingInitial);
      expect(store.getAggregateState('other', 'id-1')).toEqual(otherInitial);
    });
  });

  test('does not affect other subjects', () => {
    const store = inmemory()(aggregates);

    store.applyAggregateProjection('c')({
      aggregateName: 'thing',
      aggregateId: 'id-1',
      type: 'CREATED',
      timestamp: 1,
    });
    store.applyAggregateProjection('c')({
      aggregateName: 'thing',
      aggregateId: 'id-2',
      type: 'CREATED',
      timestamp: 2,
    });

    return store.forgetSubject('id-1').then(() => {
      expect(store.getAggregateState('thing', 'id-1')).toBeUndefined();
      expect(store.getAggregateState('thing', 'id-2')).toEqual({
        flag: 'created',
      });
    });
  });

  test('returns a promise', () => {
    const store = inmemory()(aggregates);
    const result = store.forgetSubject('nonexistent');
    expect(result).toBeInstanceOf(Promise);
    return result;
  });
});
