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

const collectProjections = (
  readModels,
  event,
  isSkipped,
  isCatchingUp,
  queueForCatchup,
) =>
  Promise.resolve(
    Object.keys(readModels)
      .map((rmName) => {
        if (isSkipped && isSkipped(rmName)) return null;
        if (isCatchingUp && isCatchingUp(rmName)) {
          if (queueForCatchup) queueForCatchup(rmName, event);
          return null;
        }
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

const updateSecondaryTimestamp = (context, rmName, timestamp) =>
  context.secondaryTimestampStorage
    ? context.secondaryTimestampStorage
        .writeTimestamp(rmName, timestamp)
        .catch((err) => {
          const log = getLogger('RM/Timestamp', 'SYS');
          log.error(
            `Failed to write secondary timestamp for ${rmName}: ${err}`,
          );
        })
    : Promise.resolve();

const handleProjections =
  (correlationId, log, context, getProjectionContext, inReplay, event) =>
  (rmProjections) =>
    Promise.all(
      rmProjections.map(([rmName, f]) =>
        f(
          getProjectionContext(correlationId)(rmName)({
            inReplay,
            suppressNotifications: false,
          }),
          event,
        )
          .then(() =>
            updateTimestamp(
              correlationId,
              context.storage,
              rmName,
              event.timestamp,
            ),
          )
          .then(() => {
            if (!inReplay) {
              return updateSecondaryTimestamp(context, rmName, event.timestamp);
            }
          })
          .then(() => {
            if (!inReplay && context.statusTracker) {
              context.statusTracker.updateLastProjectedEventTimestamp(
                rmName,
                event.timestamp,
              );
            }
          })
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
  (
    context,
    eventQueue,
    getProjectionContext,
    isReadModelReplaying,
    isReadModelCatchingUp,
    queueLiveEventForCatchup,
  ) =>
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
            collectProjections(
              context.readModels,
              event,
              isReadModelReplaying,
              isReadModelCatchingUp,
              queueLiveEventForCatchup
                ? (rmName, evt) =>
                    queueLiveEventForCatchup(rmName, correlationId, evt)
                : undefined,
            )
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

const MAX_FIFO_SIZE = 100000;

export const createProjectionHandler = (context) => {
  const eventQueue = createContextQueue(1, Infinity);
  const readModelReplayState = new Map();
  const readModelTerminalState = new Map();
  const readModelCatchupState = new Map();
  const readModelReplayOptions = new Map();

  const isReadModelReplaying = (rmName) =>
    readModelReplayState.get(rmName) === true;

  const isReadModelCatchingUp = (rmName) =>
    readModelCatchupState.get(rmName)?.active === true;

  const setReadModelCatchingUp = (rmName) => {
    const rm = context.readModels[rmName];
    readModelCatchupState.set(rmName, {
      active: true,
      fifoQueue: [],
      catchupEventFingerprints: new Set(),
      lastCatchupTimestamp: rm?.lastProjectedEventTimestamp || 0,
    });
  };

  const queueLiveEvent = (rmName, correlationId, event) => {
    const state = readModelCatchupState.get(rmName);
    if (!state) return;
    if (state.fifoQueue.length >= MAX_FIFO_SIZE) {
      const log = getLogger('RM/CatchUp', correlationId);
      log.error(
        `FIFO queue overflow for ${rmName} (${MAX_FIFO_SIZE} events). ` +
          `Cancelling catch-up.`,
      );
      clearCatchupState(rmName);
      if (context.lifecycleManager) {
        context.lifecycleManager.stop(rmName, correlationId);
      }
      return;
    }
    state.fifoQueue.push({ correlationId, event });
  };

  const recordCatchupEventFingerprint = (rmName, event) => {
    const state = readModelCatchupState.get(rmName);
    if (!state) return;
    const fingerprint = `${event.timestamp}:${event.type}:${event.aggregateId}`;
    state.catchupEventFingerprints.add(fingerprint);
    state.lastCatchupTimestamp = event.timestamp;
  };

  const clearCatchupState = (rmName) => {
    readModelCatchupState.delete(rmName);
  };

  const getFifoQueueSize = (rmName) =>
    readModelCatchupState.get(rmName)?.fifoQueue?.length || 0;

  const getCatchupState = (rmName) => readModelCatchupState.get(rmName) || null;

  const wrapSideEffectsWithFilter = (
    realHandler,
    byNameFilter,
    correlationId,
  ) => {
    const filterLog = getLogger('RM/Filter', correlationId);
    return {
      schedule: (promiseGenerator, options = {}) => {
        const name = options.name || 'unnamed';
        const shouldRun =
          byNameFilter.type === 'include'
            ? byNameFilter.names.includes(name)
            : !byNameFilter.names.includes(name);

        if (!shouldRun) {
          filterLog.debug(
            `Side-effect '${name}' filtered out ` +
              `by ${byNameFilter.type} filter`,
          );
          return Promise.resolve();
        }
        return realHandler.schedule(promiseGenerator, options);
      },
    };
  };

  const wrapCommandsWithFilter = (realCommands, byCommandFilter) => ({
    execute: (cmd) => {
      const cmdType = cmd.type || '';
      const shouldRun =
        byCommandFilter.type === 'include'
          ? byCommandFilter.commands.includes(cmdType)
          : !byCommandFilter.commands.includes(cmdType);

      if (!shouldRun) {
        return () => Promise.resolve();
      }
      return realCommands.execute(cmd);
    },
  });

  const getProjectionContext =
    (correlationId) =>
    (rmName) =>
    ({
      inReplay = false,
      suppressNotifications = false,
      sideEffectFilter = null,
      enableSideEffects = false,
      suppressSideEffects = false,
    } = {}) => {
      const resolveCommands = () => {
        if (sideEffectFilter?.byCommand) {
          return wrapCommandsWithFilter(
            context.commands(correlationId),
            sideEffectFilter.byCommand,
          );
        }
        // enableSideEffects un-stubs commands during replay
        if (inReplay && !enableSideEffects) {
          return { execute: () => () => Promise.resolve() };
        }
        // suppressSideEffects stubs commands during catch-up
        if (!inReplay && suppressSideEffects) {
          return { execute: () => () => Promise.resolve() };
        }
        return context.commands(correlationId);
      };

      const resolveSideEffects = () => {
        if (sideEffectFilter?.byName) {
          const realHandler = context.sideEffects.getSideEffectsHandler(
            correlationId,
            false,
          );
          return wrapSideEffectsWithFilter(
            realHandler,
            sideEffectFilter.byName,
            correlationId,
          );
        }
        // suppressSideEffects stubs sideEffects during catch-up
        if (!inReplay && suppressSideEffects) {
          return context.sideEffects.getSideEffectsHandler(correlationId, true);
        }
        // enableSideEffects un-stubs sideEffects during replay
        if (inReplay && enableSideEffects) {
          return context.sideEffects.getSideEffectsHandler(
            correlationId,
            false,
          );
        }
        return context.sideEffects.getSideEffectsHandler(
          correlationId,
          inReplay,
        );
      };

      return {
        storage: context.storage.perRequest(correlationId),
        commands: resolveCommands(),
        changeNotification:
          inReplay || suppressNotifications
            ? {
                sendChangeNotification: () => Promise.resolve(),
                createChangeInfo:
                  context.changeNotification(correlationId).createChangeInfo,
              }
            : context.changeNotification(correlationId),
        log: getLogger(`RM/${rmName}`, correlationId),
        sideEffects: resolveSideEffects(),
      };
    };

  const projectEventForReadModel = (correlationId, targetRmName) => {
    const log = getLogger('RM/Replay', correlationId);
    return (event) => {
      const rm = context.readModels[targetRmName];
      if (!rm) return Promise.resolve();
      const projection = rm.projections && rm.projections[event.type];
      if (!projection) return Promise.resolve();
      const opts = readModelReplayOptions.get(targetRmName) || {};
      return eventQueue.add(() =>
        projection(
          getProjectionContext(correlationId)(targetRmName)({
            inReplay: true,
            suppressNotifications: true,
            sideEffectFilter: opts.sideEffectFilter || null,
            enableSideEffects: opts.enableSideEffects || false,
          }),
          event,
        )
          .then(() => {
            if (context.statusTracker) {
              context.statusTracker.updateProgress(
                targetRmName,
                'replayProgress',
                {
                  eventsProcessed:
                    (context.statusTracker.getStatus(targetRmName)
                      ?.replayProgress?.eventsProcessed || 0) + 1,
                },
              );
            }
          })
          .catch((err) => {
            log.error(
              `Replay projection error for ${targetRmName}/${event.type}: ${err}`,
            );
            throw err;
          }),
      );
    };
  };

  const projectCatchupEventForReadModel = (correlationId, targetRmName) => {
    const log = getLogger('RM/CatchUp', correlationId);
    return (event) => {
      const rm = context.readModels[targetRmName];
      if (!rm) return Promise.resolve();
      const projection = rm.projections && rm.projections[event.type];
      if (!projection) return Promise.resolve();
      recordCatchupEventFingerprint(targetRmName, event);
      const opts = readModelReplayOptions.get(targetRmName) || {};
      return eventQueue.add(() =>
        projection(
          getProjectionContext(correlationId)(targetRmName)({
            inReplay: false,
            suppressNotifications: true,
            sideEffectFilter: opts.sideEffectFilter || null,
            suppressSideEffects: opts.suppressSideEffects || false,
          }),
          event,
        )
          .then(() => {
            context.readModels[targetRmName].lastProjectedEventTimestamp =
              event.timestamp;
            if (context.statusTracker) {
              context.statusTracker.updateLastProjectedEventTimestamp(
                targetRmName,
                event.timestamp,
              );
              context.statusTracker.updateProgress(
                targetRmName,
                'catchupProgress',
                {
                  eventsProcessed:
                    (context.statusTracker.getStatus(targetRmName)
                      ?.catchupProgress?.eventsProcessed || 0) + 1,
                },
              );
            }
            return updateTimestamp(
              correlationId,
              context.storage,
              targetRmName,
              event.timestamp,
            ).then(() =>
              updateSecondaryTimestamp(context, targetRmName, event.timestamp),
            );
          })
          .catch((err) => {
            log.error(
              `Catch-up projection error for ${targetRmName}/${event.type}: ${err}`,
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
      isReadModelCatchingUp,
      queueLiveEvent,
    ),
    projectEventForReadModel,
    projectCatchupEventForReadModel,
    setReadModelReplayState: (rmName, state) => {
      readModelReplayState.set(rmName, state);
      readModelTerminalState.delete(rmName);
    },
    clearReadModelReplayState: (rmName) => {
      readModelReplayState.delete(rmName);
    },
    isReadModelReplaying,
    getReadModelReplayStates: () => Object.fromEntries(readModelReplayState),
    getReadModelTerminalStatus: (rmName) =>
      readModelTerminalState.get(rmName) || null,
    setReadModelTerminalStatus: (rmName, status) => {
      readModelTerminalState.set(rmName, status);
    },
    setReadModelCatchingUp,
    isReadModelCatchingUp,
    queueLiveEvent,
    recordCatchupEventFingerprint,
    clearCatchupState,
    getFifoQueueSize,
    getCatchupState,
    setReplayOptions: (rmName, options) => {
      if (
        (options.enableSideEffects || options.suppressSideEffects) &&
        !context.developmentMode
      ) {
        const log = getLogger('RM/Projections', 'GUARD');
        log.error(
          `REJECTED: enableSideEffects/suppressSideEffects requires ` +
            `development mode but this RM service is NOT in development ` +
            `mode. This is a safety check — these options are not allowed ` +
            `in production.`,
        );
        return;
      }
      readModelReplayOptions.set(rmName, options);
    },
    clearReplayOptions: (rmName) => {
      readModelReplayOptions.delete(rmName);
    },
    getReplayOptions: (rmName) => readModelReplayOptions.get(rmName) || null,
    // Convenience aliases for filter-only use
    setSideEffectFilter: (rmName, filter) => {
      if (!context.developmentMode) {
        const log = getLogger('RM/Projections', 'GUARD');
        log.error(
          `REJECTED: setSideEffectFilter requires development mode but ` +
            `this RM service is NOT in development mode. This is a safety ` +
            `check — side-effect filters are not allowed in production.`,
        );
        return;
      }
      const existing = readModelReplayOptions.get(rmName) || {};
      readModelReplayOptions.set(rmName, {
        ...existing,
        sideEffectFilter: filter,
      });
    },
    clearSideEffectFilter: (rmName) => {
      const existing = readModelReplayOptions.get(rmName);
      if (!existing) return;
      const rest = Object.fromEntries(
        Object.entries(existing).filter(([key]) => key !== 'sideEffectFilter'),
      );
      if (Object.keys(rest).length === 0) {
        readModelReplayOptions.delete(rmName);
      } else {
        readModelReplayOptions.set(rmName, rest);
      }
    },
    getSideEffectFilter: (rmName) =>
      (readModelReplayOptions.get(rmName) || {}).sideEffectFilter || null,
    flushEventQueue: () => eventQueue.add(() => Promise.resolve()),
    // Run a function as a task inside the serialized event queue. Used
    // for decisions that must be atomic with respect to event processing
    // (e.g. the catch-up completion check) — while the task runs, no
    // event is mid-projection.
    runInEventQueue: (fn) => eventQueue.add(() => Promise.resolve(fn())),
    // Number of tasks waiting in the event queue (excluding the one
    // currently running). Inside a runInEventQueue task this reveals
    // whether events are pending behind the current task.
    getEventQueueLength: () => eventQueue.getQueueLength(),
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
