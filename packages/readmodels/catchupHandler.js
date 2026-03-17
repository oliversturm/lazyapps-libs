import { getLogger } from '@lazyapps/logger';

const isDuplicate = (event, catchupState, toTimestamp) => {
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
        // Flush the event queue to ensure all pending live events
        // have been processed through collectProjections and moved
        // to the FIFO before we declare the drain complete.
        return context.projectionHandler.flushEventQueue().then(() => {
          const late = state.fifoQueue.shift();
          if (late) {
            // New events arrived while flushing — continue draining
            const { correlationId: lateCorrelationId, event: lateEvent } = late;
            if (isDuplicate(lateEvent, state, toTimestamp)) {
              return drainNext();
            }
            return context.projectionHandler
              .projectCatchupEventForReadModel(lateCorrelationId, readModel)(
                lateEvent,
              )
              .then(drainNext);
          }
          context.projectionHandler.clearCatchupState(readModel);
          log.info(`FIFO drain complete for ${readModel}`);
          return Promise.resolve();
        });
      }

      const { correlationId: entryCorrelationId, event } = entry;

      if (isDuplicate(event, state, toTimestamp)) {
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
