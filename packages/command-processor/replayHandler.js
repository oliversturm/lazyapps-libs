import { getLogger } from '@lazyapps/logger';

export const createReplayHandler = (eventStore, eventBus) => {
  const replays = {};

  const startReplay = (
    correlationId,
    readModel,
    fromTimestamp,
    toTimestamp,
    targetEndpointName,
  ) => {
    if (replays[readModel] && replays[readModel].status === 'in_progress') {
      return Promise.reject(
        new Error(`Replay already in progress for ${readModel}`),
      );
    }
    const log = getLogger('CP/Replay', correlationId);
    let cancelled = false;
    let activeCursor = null;

    replays[readModel] = {
      status: 'in_progress',
      readModel,
      eventsPublished: 0,
      eventsTotal: 0,
      startedAt: Date.now(),
      cancel: () => {
        cancelled = true;
        if (activeCursor) activeCursor.close().catch(() => {});
      },
    };

    return eventStore
      .countEvents(fromTimestamp, toTimestamp)
      .then((total) => {
        replays[readModel].eventsTotal = total;
        log.info(`Starting replay of ${total} events for ${readModel}`);
        return eventStore.streamEvents(fromTimestamp, toTimestamp);
      })
      .then((cursor) => {
        activeCursor = cursor;
        const processNext = () =>
          cursor.next().then((event) => {
            if (!event || cancelled) return Promise.resolve();
            eventBus.publishReplayEvent(correlationId)(
              readModel,
              event,
              targetEndpointName,
            );
            replays[readModel].eventsPublished++;
            if (replays[readModel].eventsPublished % 1000 === 0) {
              log.info(
                `Replay progress: ${replays[readModel].eventsPublished}/${replays[readModel].eventsTotal}`,
              );
            }
            return processNext();
          });
        return processNext();
      })
      .then(() => {
        activeCursor = null;
        if (cancelled) {
          log.info(`Replay cancelled for ${readModel}`);
          eventBus.publishSystemMessage(correlationId)({
            type: 'REPLAY_CANCELLED',
            readModel,
            ...(targetEndpointName && { targetEndpointName }),
          });
          replays[readModel] = {
            ...replays[readModel],
            status: 'cancelled',
            cancel: undefined,
          };
        } else {
          log.info(`Replay complete for ${readModel}`);
          eventBus.publishSystemMessage(correlationId)({
            type: 'REPLAY_EVENTS_DONE',
            readModel,
            ...(targetEndpointName && { targetEndpointName }),
          });
          replays[readModel] = {
            ...replays[readModel],
            status: 'completed',
            cancel: undefined,
          };
        }
      })
      .catch((err) => {
        activeCursor = null;
        log.error(`Replay failed for ${readModel}: ${err}`);
        eventBus.publishSystemMessage(correlationId)({
          type: 'REPLAY_CANCELLED',
          readModel,
          ...(targetEndpointName && { targetEndpointName }),
        });
        replays[readModel] = {
          ...replays[readModel],
          status: 'error',
          error: String(err),
          cancel: undefined,
        };
      });
  };

  const cancelReplay = (correlationId, readModel) => {
    const replay = replays[readModel];
    if (!replay || replay.status !== 'in_progress') return Promise.resolve();
    const log = getLogger('CP/Replay', correlationId);
    log.info(`Cancelling replay for ${readModel}`);
    replay.cancel();
    return Promise.resolve();
  };

  const getReplayStatus = (readModel) =>
    replays[readModel] || { status: 'idle', readModel };

  return { startReplay, cancelReplay, getReplayStatus };
};
