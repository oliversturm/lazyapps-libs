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
    return store
      .applyAggregateProjection('correlation')(event)
      .then((result) => {
        expect(result).toEqual(event);

        // Not the cleanest stuff to test, but it confirms
        // the algorithm does what it should. For now.
        expect(log.debug).toBeCalledTimes(1);
        expect(log.warn).toBeCalledTimes(0);
        return store.getAggregateState('thing', 'id-1');
      })
      .then((state) => {
        expect(state).toEqual({ flag: 'created' });
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
    return store
      .applyAggregateProjection('correlation')(event)
      .then((result) => {
        expect(result).toEqual(event);

        // Not the cleanest stuff to test, but it confirms
        // the algorithm does what it should. For now.
        expect(log.debug).toBeCalledTimes(1);
        expect(log.warn).toBeCalledTimes(0);
        return store.getAggregateState('thing', 'id-1');
      })
      .then((state) => {
        expect(state).toBeUndefined();
      });
  });

  test('event out of sequence', () => {
    const store = inmemory()(aggregates);
    const event1 = {
      aggregateName: 'thing',
      aggregateId: 'id-1',
      type: 'CREATED',
      timestamp: 55,
    };
    return store
      .applyAggregateProjection('correlation')(event1)
      .then(() => {
        const event2 = {
          aggregateName: 'thing',
          aggregateId: 'id-2',
          type: 'CREATED',
          timestamp: 33,
        };
        return store.applyAggregateProjection('correlation')(event2);
      })
      .then(() => {
        expect(log.debug).toBeCalledTimes(3); // 1 for event1, 2 for event 2 (projection + out of sequence notice)
      });
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

    return store
      .applyAggregateProjection('c')({
        aggregateName: 'thing',
        aggregateId: 'id-1',
        type: 'CREATED',
        timestamp: 1,
      })
      .then(() =>
        store.applyAggregateProjection('c')({
          aggregateName: 'other',
          aggregateId: 'id-1',
          type: 'CREATED',
          timestamp: 2,
        }),
      )
      .then(() =>
        Promise.all([
          store.getAggregateState('thing', 'id-1'),
          store.getAggregateState('other', 'id-1'),
        ]),
      )
      .then(([thingState, otherState]) => {
        expect(thingState).toEqual({ flag: 'created' });
        expect(otherState).toEqual({ flag: 'other-created' });
        return store.forgetSubject('id-1');
      })
      .then(() =>
        Promise.all([
          store.getAggregateState('thing', 'id-1'),
          store.getAggregateState('other', 'id-1'),
        ]),
      )
      .then(([thingState, otherState]) => {
        // After forget, getAggregateState returns the initial state
        expect(thingState).toEqual(thingInitial);
        expect(otherState).toEqual(otherInitial);
      });
  });

  test('does not affect other subjects', () => {
    const store = inmemory()(aggregates);

    return store
      .applyAggregateProjection('c')({
        aggregateName: 'thing',
        aggregateId: 'id-1',
        type: 'CREATED',
        timestamp: 1,
      })
      .then(() =>
        store.applyAggregateProjection('c')({
          aggregateName: 'thing',
          aggregateId: 'id-2',
          type: 'CREATED',
          timestamp: 2,
        }),
      )
      .then(() => store.forgetSubject('id-1'))
      .then(() =>
        Promise.all([
          store.getAggregateState('thing', 'id-1'),
          store.getAggregateState('thing', 'id-2'),
        ]),
      )
      .then(([state1, state2]) => {
        expect(state1).toBeUndefined();
        expect(state2).toEqual({ flag: 'created' });
      });
  });

  test('returns a promise', () => {
    const store = inmemory()(aggregates);
    const result = store.forgetSubject('nonexistent');
    expect(result).toBeInstanceOf(Promise);
    return result;
  });
});

describe('on-demand aggregate reconstruction', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  test('getAggregateState returns initial() on cache miss with no event store', () => {
    const store = inmemory()(aggregates);
    // No setEventStoreRef called — no event store injected
    return store.getAggregateState('thing', 'nonexistent').then((state) => {
      expect(state).toBeUndefined();
    });
  });

  test('getAggregateState reconstructs from events on cold start', () => {
    const customerAggregates = {
      customer: {
        initial: () => ({}),
        projections: {
          CUSTOMER_CREATED: (state, event) => ({
            ...state,
            name: event.payload.name,
            creationTimestamp: event.timestamp,
          }),
          CUSTOMER_UPDATED: (state, event) => ({
            ...state,
            name: event.payload.name,
          }),
        },
      },
    };
    const store = inmemory()(customerAggregates);

    const events = [
      {
        aggregateName: 'customer',
        aggregateId: 'cust-1',
        type: 'CUSTOMER_CREATED',
        payload: { name: 'Alice' },
        timestamp: 100,
      },
      {
        aggregateName: 'customer',
        aggregateId: 'cust-1',
        type: 'CUSTOMER_UPDATED',
        payload: { name: 'Alice Smith' },
        timestamp: 200,
      },
    ];

    const mockGetEventsForAggregate = vi.fn().mockResolvedValue(events);
    store.setEventStoreRef(mockGetEventsForAggregate);

    // Fresh store, no prior cache population — first access triggers reconstruction
    return store.getAggregateState('customer', 'cust-1').then((state) => {
      expect(mockGetEventsForAggregate).toHaveBeenCalledWith(
        'customer',
        'cust-1',
      );
      expect(state).toEqual({
        name: 'Alice Smith',
        creationTimestamp: 100,
      });
    });
  });

  test('getAggregateState caches reconstructed state', () => {
    const customerAggregates = {
      customer: {
        initial: () => ({}),
        projections: {
          CUSTOMER_CREATED: (state, event) => ({
            ...state,
            name: event.payload.name,
          }),
        },
      },
    };
    const store = inmemory()(customerAggregates);

    const events = [
      {
        aggregateName: 'customer',
        aggregateId: 'cust-1',
        type: 'CUSTOMER_CREATED',
        payload: { name: 'Alice' },
        timestamp: 100,
      },
    ];

    const mockGetEventsForAggregate = vi.fn().mockResolvedValue(events);
    store.setEventStoreRef(mockGetEventsForAggregate);

    // First access reconstructs
    return store
      .getAggregateState('customer', 'cust-1')
      .then(() => store.getAggregateState('customer', 'cust-1'))
      .then(() => {
        // Should only call event store once — second access uses cache
        expect(mockGetEventsForAggregate).toHaveBeenCalledTimes(1);
      });
  });

  test('getAggregateState reconstructs from events after forget', () => {
    const customerAggregates = {
      customer: {
        initial: () => ({}),
        projections: {
          CUSTOMER_CREATED: (state, event) => ({
            ...state,
            name: event.payload.name,
            creationTimestamp: event.timestamp,
          }),
          CUSTOMER_UPDATED: (state, event) => ({
            ...state,
            name: event.payload.name,
          }),
        },
      },
    };
    const store = inmemory()(customerAggregates);

    const events = [
      {
        aggregateName: 'customer',
        aggregateId: 'cust-1',
        type: 'CUSTOMER_CREATED',
        payload: { name: 'Alice' },
        timestamp: 100,
      },
      {
        aggregateName: 'customer',
        aggregateId: 'cust-1',
        type: 'CUSTOMER_UPDATED',
        payload: { name: 'Alice Smith' },
        timestamp: 200,
      },
    ];

    const mockGetEventsForAggregate = vi.fn().mockResolvedValue(events);

    store.setEventStoreRef(mockGetEventsForAggregate);

    // First, populate cache via projection
    return store
      .applyAggregateProjection('c')(events[0])
      .then(() => store.applyAggregateProjection('c')(events[1]))
      .then(() => store.getAggregateState('customer', 'cust-1'))
      .then((stateBefore) => {
        expect(stateBefore).toEqual({
          name: 'Alice Smith',
          creationTimestamp: 100,
        });
        // Forget evicts cache
        return store.forgetSubject('cust-1');
      })
      .then(() => store.getAggregateState('customer', 'cust-1'))
      .then((stateAfter) => {
        // Should reconstruct from events
        expect(mockGetEventsForAggregate).toHaveBeenCalledWith(
          'customer',
          'cust-1',
        );
        expect(stateAfter).toEqual({
          name: 'Alice Smith',
          creationTimestamp: 100,
        });
      });
  });

  test('reconstructed state uses fallback values for forgotten subjects', () => {
    const customerAggregates = {
      customer: {
        initial: () => ({}),
        projections: {
          CUSTOMER_CREATED: (state, event) => ({
            ...state,
            name: event.payload.name,
            location: event.payload.location,
            creationTimestamp: event.timestamp,
          }),
        },
      },
    };
    const store = inmemory()(customerAggregates);

    // Events with fallback values (as would come from decryptEventSafe
    // after subject is forgotten)
    const eventsWithFallbacks = [
      {
        aggregateName: 'customer',
        aggregateId: 'cust-1',
        type: 'CUSTOMER_CREATED',
        payload: { name: '[deleted]', location: '[deleted]' },
        timestamp: 100,
      },
    ];

    const mockGetEventsForAggregate = vi
      .fn()
      .mockResolvedValue(eventsWithFallbacks);

    store.setEventStoreRef(mockGetEventsForAggregate);

    return store.getAggregateState('customer', 'cust-1').then((state) => {
      expect(state).toEqual({
        name: '[deleted]',
        location: '[deleted]',
        creationTimestamp: 100,
      });
    });
  });
});
