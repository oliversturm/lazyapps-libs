import { getLogger } from '@lazyapps/logger';
import { metrics } from '@opentelemetry/api';
import { createContextQueue } from './contextQueue.js';
import { withSpan } from './tracing.js';

const meter = metrics.getMeter('@lazyapps/readmodels');

const projectionCounter = meter.createCounter('lazyapps.projections.total', {
  description: 'Total projections executed',
});

const projectionDuration = meter.createHistogram(
  'lazyapps.projections.duration_ms',
  {
    description: 'Projection execution time in milliseconds',
    unit: 'ms',
  },
);

const collectProjections = (readModels, event, isSkipped) =>
  Promise.resolve(
    Object.keys(readModels)
      .map((rmName) => {
        if (isSkipped && isSkipped(rmName)) return null;
        const rm = readModels[rmName];
        const projection = rm.projections && rm.projections[event.type];
        if (projection) {
          return [rmName, projection];
        } else return null;
      })
      .filter((el) => !!el)
      .filter(([, f]) => !!f),
  );

const logProjections = (log, inReplay) => (rmProjections) => {
  if (rmProjections.length)
    log.debug(
      `Projecting event for read models: ${JSON.stringify(
        rmProjections.map(([rmName]) => rmName),
      )} (inReplay=${inReplay})`,
    );
  return rmProjections;
};

const updateInternalReadModelTimestamps =
  (event, readModels) => (rmProjections) =>
    Promise.all(
      rmProjections.map(([rmName]) => {
        readModels[rmName].lastProjectedEventTimestamp = event.timestamp;
      }),
    ).then(() => rmProjections);

const updateTimestamp = (correlationId, storage, rmName, timestamp) =>
  storage.updateLastProjectedEventTimestamps(
    correlationId,
    [rmName],
    timestamp,
  );

const handleProjections =
  (correlationId, log, context, getProjectionContext, inReplay, event) =>
  (rmProjections) =>
    Promise.all(
      rmProjections.map(([rmName, f]) =>
        f(getProjectionContext(correlationId)(rmName)(inReplay), event)
          .then(() =>
            updateTimestamp(
              correlationId,
              context.storage,
              rmName,
              event.timestamp,
            ),
          )
          .catch((err) => {
            log.error(
              `Error occurred projecting event ${JSON.stringify(
                event,
              )} for read model ${rmName}, or during read model timestamp update: ${err}`,
            );
          }),
      ),
    );

const projectEvent =
  (context, eventQueue, getProjectionContext, isReadModelReplaying) =>
  (correlationId) => {
    const log = getLogger(`RM/ProjEv`, correlationId);
    return (event, inReplay) => {
      const startTime = Date.now();
      return eventQueue.add(() =>
        withSpan(
          'lazyapps.readmodel.projectEvent',
          {
            'event.type': event.type,
            'readmodel.names': Object.keys(context.readModels).join(','),
          },
          () =>
            collectProjections(context.readModels, event, isReadModelReplaying)
              .then(logProjections(log, inReplay))
              .then(
                updateInternalReadModelTimestamps(event, context.readModels),
              )
              .then(
                handleProjections(
                  correlationId,
                  log,
                  context,
                  getProjectionContext,
                  inReplay,
                  event,
                ),
              )
              .then((result) => {
                const duration = Date.now() - startTime;
                projectionCounter.add(1, { 'event.type': event.type });
                projectionDuration.record(duration, {
                  'event.type': event.type,
                });
                return result;
              }),
        ),
      );
    };
  };

export const createProjectionHandler = (context) => {
  const eventQueue = createContextQueue(1, Infinity);
  const readModelReplayState = {};

  const isReadModelReplaying = (rmName) =>
    readModelReplayState[rmName] === true;

  const getProjectionContext = (correlationId) => (rmName) => (inReplay) => ({
    storage: context.storage.perRequest(correlationId),
    commands: inReplay
      ? { execute: () => () => Promise.resolve() }
      : context.commands(correlationId),
    changeNotification: inReplay
      ? {
          sendChangeNotification: () => Promise.resolve(),
          createChangeInfo:
            context.changeNotification(correlationId).createChangeInfo,
        }
      : context.changeNotification(correlationId),
    log: getLogger(`RM/${rmName}`, correlationId),
    sideEffects: context.sideEffects.getSideEffectsHandler(
      correlationId,
      inReplay,
    ),
  });

  const projectEventForReadModel = (correlationId, targetRmName) => {
    const log = getLogger('RM/Replay', correlationId);
    return (event) => {
      const rm = context.readModels[targetRmName];
      if (!rm) return Promise.resolve();
      const projection = rm.projections && rm.projections[event.type];
      if (!projection) return Promise.resolve();
      return eventQueue.add(() =>
        projection(
          getProjectionContext(correlationId)(targetRmName)(true),
          event,
        )
          .then(() =>
            updateTimestamp(
              correlationId,
              context.storage,
              targetRmName,
              event.timestamp,
            ),
          )
          .catch((err) => {
            log.error(
              `Replay projection error for ${targetRmName}/${event.type}: ${err}`,
            );
            throw err;
          }),
      );
    };
  };

  return {
    projectEvent: projectEvent(
      context,
      eventQueue,
      getProjectionContext,
      isReadModelReplaying,
    ),
    projectEventForReadModel,
    setReadModelReplayState: (rmName, state) => {
      readModelReplayState[rmName] = state;
    },
    clearReadModelReplayState: (rmName) => {
      delete readModelReplayState[rmName];
    },
    isReadModelReplaying,
    getReadModelReplayStates: () => ({ ...readModelReplayState }),
  };
};

export const testing = {
  collectProjections,
  logProjections,
  updateInternalReadModelTimestamps,
  updateTimestamp,
  handleProjections,
  projectEvent,
  createProjectionHandler,
};
