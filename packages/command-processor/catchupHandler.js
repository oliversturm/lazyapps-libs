import { getLogger } from '@lazyapps/logger';

export const createCatchupHandler = (eventStore, eventBus, statusTracker) => {
  const catchups = {};

  const startCatchup = (
    correlationId,
    readModel,
    fromTimestamp,
    targetEndpointName,
    replayRelevantEvents,
  ) => {
    if (catchups[readModel] && catchups[readModel].status === 'in_progress') {
      return Promise.reject(
        new Error(`Catch-up already in progress for ${readModel}`),
      );
    }
    const log = getLogger('CP/CatchUp', correlationId);
    let cancelled = false;
    let activeCursor = null;
    const eventFilter =
      replayRelevantEvents && replayRelevantEvents.length > 0
        ? new Set(replayRelevantEvents)
        : null;

    catchups[readModel] = {
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

    if (statusTracker) {
      statusTracker.trackCatchUpStart(
        readModel,
        targetEndpointName,
        correlationId,
      );
    }

    return eventStore
      .getLatestEventTimestamp()
      .then((toTimestamp) => {
        if (!toTimestamp) {
          log.info(`Event store is empty, nothing to catch up`);
          catchups[readModel] = {
            ...catchups[readModel],
            status: 'completed',
            cancel: undefined,
          };
          if (statusTracker) {
            statusTracker.trackCatchUpEnd(readModel, targetEndpointName);
          }
          return;
        }

        if (statusTracker) {
          statusTracker.trackCatchUpSetToTimestamp(
            readModel,
            targetEndpointName,
            toTimestamp,
          );
        }

        return eventStore
          .countEvents(fromTimestamp, toTimestamp)
          .then((total) => {
            catchups[readModel].eventsTotal = total;
            log.info(
              `Starting catch-up of ${total} events for ${readModel} ` +
                `(from ${fromTimestamp} to ${toTimestamp})`,
            );
            return eventStore.streamEvents(fromTimestamp, toTimestamp);
          })
          .then((cursor) => {
            activeCursor = cursor;
            const processNext = () =>
              cursor.next().then((event) => {
                if (!event || cancelled) return Promise.resolve();
                if (eventFilter && !eventFilter.has(event.type)) {
                  return processNext();
                }
                log.debug(
                  `Catch-up event for ${readModel}: ${JSON.stringify(event)}`,
                );
                eventBus.publishCatchupEvent(correlationId)(
                  readModel,
                  event,
                  targetEndpointName,
                );
                catchups[readModel].eventsPublished++;
                if (statusTracker) {
                  statusTracker.trackCatchUpEvent(
                    readModel,
                    targetEndpointName,
                    event.timestamp,
                  );
                }
                if (catchups[readModel].eventsPublished % 1000 === 0) {
                  log.info(
                    `Catch-up progress: ${catchups[readModel].eventsPublished}` +
                      `/${catchups[readModel].eventsTotal}`,
                  );
                }
                return processNext();
              });
            return processNext();
          })
          .then(() => {
            activeCursor = null;
            if (cancelled) {
              log.info(`Catch-up cancelled for ${readModel}`);
              catchups[readModel] = {
                ...catchups[readModel],
                status: 'cancelled',
                cancel: undefined,
              };
            } else {
              log.info(`Catch-up complete for ${readModel}`);
              catchups[readModel] = {
                ...catchups[readModel],
                status: 'completed',
                cancel: undefined,
              };
            }
            if (statusTracker) {
              statusTracker.trackCatchUpEnd(readModel, targetEndpointName);
            }
          });
      })
      .catch((err) => {
        activeCursor = null;
        log.error(`Catch-up failed for ${readModel}: ${err}`);
        catchups[readModel] = {
          ...catchups[readModel],
          status: 'error',
          error: String(err),
          cancel: undefined,
        };
        if (statusTracker) {
          statusTracker.trackCatchUpEnd(readModel, targetEndpointName);
        }
      });
  };

  const cancelCatchup = (correlationId, readModel) => {
    const catchup = catchups[readModel];
    if (!catchup || catchup.status !== 'in_progress') return Promise.resolve();
    const log = getLogger('CP/CatchUp', correlationId);
    log.info(`Cancelling catch-up for ${readModel}`);
    catchup.cancel();
    return Promise.resolve();
  };

  const getCatchupStatus = (readModel) =>
    catchups[readModel] || { status: 'idle', readModel };

  return { startCatchup, cancelCatchup, getCatchupStatus };
};
