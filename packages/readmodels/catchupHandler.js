import { getLogger } from '@lazyapps/logger';

const isDuplicate = (event, catchupState) => {
  if (event.timestamp < catchupState.lastCatchupTimestamp) return true;

  if (event.timestamp === catchupState.lastCatchupTimestamp) {
    const fp = `${event.timestamp}:${event.type}:${event.aggregateId}`;
    return catchupState.catchupEventFingerprints.has(fp);
  }

  return false;
};

export const createCatchupHandler = (context) => {
  const handleCatchupComplete = (readModel, toTimestamp, correlationId) => {
    const log = getLogger('RM/CatchUp', correlationId || 'SYS');
    log.info(`Catch-up events done for ${readModel}, draining FIFO queue`);

    const state = context.projectionHandler.getCatchupState(readModel);
    if (!state) {
      log.warn(`No catch-up state found for ${readModel}`);
      return Promise.resolve();
    }

    const drainNext = () => {
      const entry = state.fifoQueue.shift();
      if (!entry) {
        // Decide completion INSIDE the serialized event queue. While this
        // task runs, no live event can be mid-projection: every event that
        // entered the queue before it has either been projected or pushed
        // to the FIFO, and every event after it will still see the catchup
        // state until we clear it here. Deciding outside the queue (e.g.
        // after a flushEventQueue().then()) leaves a window where events
        // already sitting in the queue behind the flush marker are
        // projected as plain live events after the state flips — skipping
        // dedup and duplicating catch-up events.
        return context.projectionHandler
          .runInEventQueue(() => {
            // Only flip when nothing is pending: an event enqueued after
            // this check task would still see the catchup state cleared
            // below even though it was emitted during catch-up — so as
            // long as tasks wait behind us, defer the decision to a
            // later check.
            if (
              state.fifoQueue.length === 0 &&
              context.projectionHandler.getEventQueueLength() === 0
            ) {
              context.projectionHandler.clearCatchupState(readModel);
              return true;
            }
            log.debug(
              `Drain not complete for ${readModel} (FIFO: ` +
                `${state.fifoQueue.length}, pending queue: ` +
                `${context.projectionHandler.getEventQueueLength()}) — ` +
                `continuing drain`,
            );
            return false;
          })
          .then((complete) => {
            if (complete) {
              log.info(`FIFO drain complete for ${readModel}`);
              return Promise.resolve();
            }
            return drainNext();
          });
      }

      const { correlationId: entryCorrelationId, event } = entry;

      if (isDuplicate(event, state)) {
        return drainNext();
      }

      return context.projectionHandler
        .projectCatchupEventForReadModel(entryCorrelationId, readModel)(event)
        .then(drainNext);
    };

    return drainNext();
  };

  const handleCatchupCancelled = (readModel, correlationId) => {
    const log = getLogger('RM/CatchUp', correlationId || 'SYS');
    log.warn(`Catch-up cancelled for ${readModel}`);
    context.projectionHandler.clearCatchupState(readModel);
    if (context.lifecycleManager) {
      context.lifecycleManager.stop(readModel, correlationId);
    }
  };

  return { handleCatchupComplete, handleCatchupCancelled };
};

export const __testing__ = { isDuplicate };
