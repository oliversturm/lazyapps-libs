import { getLogger } from '@lazyapps/logger';

const VALID_STATES = ['stopped', 'live', 'replay', 'catchup'];

const VALID_TRANSITIONS = {
  stopped: ['replay', 'catchup'],
  live: ['stopped'],
  replay: ['stopped'],
  catchup: ['live', 'stopped'],
};

export const createLifecycleManager = (context) => {
  const states = {};
  let connectPromise = null;

  const initialize = (readModelNames) => {
    const log = getLogger('RM/Lifecycle', 'SYS');
    readModelNames.forEach((name) => {
      states[name] = 'stopped';
    });
    log.info(
      `Initialized lifecycle for read models: ${readModelNames.join(', ')}`,
    );
  };

  const getState = (name) => states[name] || 'unknown';

  const isValidTransition = (from, to) => {
    const allowed = VALID_TRANSITIONS[from];
    return allowed ? allowed.includes(to) : false;
  };

  const setState = (name, state, correlationId) => {
    const log = getLogger('RM/Lifecycle', correlationId || 'SYS');
    const prev = states[name];
    states[name] = state;
    log.info(`Read model '${name}': ${prev} -> ${state}`);
    if (context.statusTracker) {
      context.statusTracker.setState(name, state, correlationId);
    }
  };

  const stop = (readModelName, correlationId) => {
    const log = getLogger('RM/Lifecycle', correlationId || 'SYS');
    const current = getState(readModelName);
    if (current === 'stopped') {
      log.info(`Read model '${readModelName}' already stopped`);
      return;
    }
    if (current === 'catchup') {
      context.projectionHandler.clearCatchupState(readModelName);
    }
    log.info(`Stopping read model '${readModelName}'`);
    setState(readModelName, 'stopped', correlationId);
  };

  const startReplay = (readModelName, correlationId) => {
    const log = getLogger('RM/Lifecycle', correlationId || 'SYS');
    const current = getState(readModelName);
    if (current !== 'stopped') {
      return Promise.reject(
        new Error(
          `Cannot start replay for '${readModelName}' from state '${current}'`,
        ),
      );
    }
    context.projectionHandler.setReadModelReplayState(readModelName, true);
    // Reset in-memory timestamp — replay always starts from scratch.
    // If events are replayed, projectEventForReadModel updates this
    // per-event (including MongoDB persistence).
    // If no events are replayed, it stays at 0 (correct).
    if (context.readModels[readModelName]) {
      context.readModels[readModelName].lastProjectedEventTimestamp = 0;
    }
    setState(readModelName, 'replay', correlationId);
    log.info(`Read model '${readModelName}' is now in replay mode`);
    return Promise.resolve();
  };

  const replayDone = (readModelName, correlationId) => {
    const log = getLogger('RM/Lifecycle', correlationId || 'SYS');
    const current = getState(readModelName);
    if (current !== 'replay') {
      log.warn(`replayDone for '${readModelName}' but state is '${current}'`);
      return;
    }
    context.projectionHandler.clearReadModelReplayState(readModelName);
    setState(readModelName, 'stopped', correlationId);
    log.info(`Read model '${readModelName}' replay done, now stopped`);
  };

  const activate = (readModelName, correlationId) => {
    const log = getLogger('RM/Lifecycle', correlationId || 'SYS');
    const current = getState(readModelName);
    if (current !== 'stopped') {
      return Promise.reject(
        new Error(`Cannot activate '${readModelName}' from state '${current}'`),
      );
    }

    log.info(`Activating read model '${readModelName}'`);

    if (!connectPromise) {
      connectPromise = context.connectEventBus().catch((err) => {
        connectPromise = null;
        throw err;
      });
    }
    const connectEventBus = connectPromise;

    return connectEventBus
      .then(() => {
        context.projectionHandler.setReadModelCatchingUp(readModelName);
        setState(readModelName, 'catchup', correlationId);
        log.info(`Read model '${readModelName}' is now catching up`);
      })
      .catch((err) => {
        log.error(`Activation failed for ${readModelName}: ${err}`);
        context.projectionHandler.clearCatchupState(readModelName);
        setState(readModelName, 'stopped', correlationId);
        throw err;
      });
  };

  const catchupDone = (readModelName, toTimestamp, correlationId) => {
    const log = getLogger('RM/Lifecycle', correlationId || 'SYS');
    const current = getState(readModelName);
    if (current !== 'catchup') {
      log.warn(`catchupDone for '${readModelName}' but state is '${current}'`);
      return Promise.resolve();
    }
    log.info(
      `Catch-up events done for '${readModelName}', draining FIFO queue`,
    );
    return context.catchupHandler
      .handleCatchupComplete(readModelName, toTimestamp, correlationId)
      .then(() => {
        setState(readModelName, 'live', correlationId);
        log.info(`Read model '${readModelName}' is now live`);
      });
  };

  return {
    initialize,
    getState,
    setState,
    activate,
    stop,
    startReplay,
    replayDone,
    catchupDone,
    isValidTransition,
  };
};

export const __testing__ = { VALID_STATES, VALID_TRANSITIONS };
