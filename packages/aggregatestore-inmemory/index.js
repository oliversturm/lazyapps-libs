import { getLogger } from '@lazyapps/logger';

export const inmemory = () => (aggregates) => {
  const store = {};
  let lastProjectedEventTimestamp = 0;
  let eventStoreRef = null;

  const setEventStoreRef = (getEventsForAggregate) => {
    eventStoreRef = getEventsForAggregate;
  };

  const reconstructFromEvents = (name, id) =>
    eventStoreRef(name, id).then((events) => {
      let state = aggregates[name].initial(id);
      for (const event of events) {
        const projection =
          aggregates[name].projections &&
          aggregates[name].projections[event.type];
        if (projection) state = projection(state, event);
      }
      setAggregateState(name, id, state);
      return state;
    });

  const getAggregateState = (name, id) =>
    store[name] && store[name][id]
      ? Promise.resolve(store[name][id])
      : eventStoreRef
        ? reconstructFromEvents(name, id)
        : Promise.resolve(aggregates[name].initial(id));

  const setAggregateState = (name, id, state) => {
    if (!store[name]) store[name] = {};
    store[name][id] = state;
  };

  const applyAggregateProjection = (correlationId) => (event) => {
    const { aggregateName, aggregateId, type, timestamp } = event;
    const projection =
      aggregates[aggregateName].projections &&
      aggregates[aggregateName].projections[type];
    const log = getLogger('CmdProc/AS', correlationId);
    return getAggregateState(aggregateName, aggregateId).then((state) => {
      if (projection) {
        const projected = projection(state, event);
        setAggregateState(aggregateName, aggregateId, projected);
        log.debug(
          `Applied aggregate projection for event timestamp ${timestamp}`,
        );
      } else {
        log.debug(
          `No aggregate projection for type in event ${JSON.stringify(event)}`,
        );
      }

      if (timestamp < lastProjectedEventTimestamp)
        log.debug(
          `Noticing event out of sequence (lastPET=${lastProjectedEventTimestamp}, ts=${timestamp}): ${JSON.stringify(
            event,
          )}`,
        );

      lastProjectedEventTimestamp = timestamp;

      return event;
    });
  };

  return {
    getAggregateState,
    setEventStoreRef,
    applyAggregateProjection,
    forgetSubject: (subjectId) => {
      for (const name of Object.keys(store)) {
        delete store[name][subjectId];
      }
      return Promise.resolve();
    },
  };
};
