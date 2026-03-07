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
  const handleCatchupComplete = (readModel, toTimestamp) => {
    const log = getLogger('RM/CatchUp', 'SYS');
    log.info(`Catch-up events done for ${readModel}, draining FIFO queue`);

    const state = context.projectionHandler.getCatchupState(readModel);
    if (!state) {
      log.warn(`No catch-up state found for ${readModel}`);
      return Promise.resolve();
    }

    const drainNext = () => {
      const entry = state.fifoQueue.shift();
      if (!entry) {
        context.projectionHandler.clearCatchupState(readModel);
        context.lifecycleManager.setState(readModel, 'live');
        log.info(`Read model ${readModel} is now live`);
        return Promise.resolve();
      }

      const { correlationId, event } = entry;

      if (isDuplicate(event, state, toTimestamp)) {
        return drainNext();
      }

      return context.projectionHandler
        .projectCatchupEventForReadModel(correlationId, readModel)(event)
        .then(drainNext);
    };

    return drainNext();
  };

  const handleCatchupCancelled = (readModel) => {
    const log = getLogger('RM/CatchUp', 'SYS');
    log.warn(`Catch-up cancelled for ${readModel}`);
    context.projectionHandler.clearCatchupState(readModel);
    context.lifecycleManager.setState(readModel, 'waiting');
  };

  return { handleCatchupComplete, handleCatchupCancelled };
};

export const __testing__ = { isDuplicate };
