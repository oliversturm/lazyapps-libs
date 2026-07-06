import { getLogger } from '@lazyapps/logger';

const VALID_STATES = [
  'idle',
  'live',
  'replay',
  'replay-done',
  'catchup',
  'invalid',
];

const BASE_TRANSITIONS = {
  idle: ['replay', 'catchup'],
  live: ['idle'],
  replay: ['replay-done'],
  'replay-done': ['catchup', 'idle'],
  catchup: ['live', 'idle'],
  invalid: [],
};

const DEV_TRANSITIONS = {
  ...BASE_TRANSITIONS,
  idle: ['replay', 'catchup', 'live'],
  'replay-done': ['catchup', 'idle', 'live'],
  invalid: ['idle'],
};

export const createLifecycleManager = (context) => {
  const VALID_TRANSITIONS = context.developmentMode
    ? DEV_TRANSITIONS
    : BASE_TRANSITIONS;
  const states = {};
  let connectPromise = null;

  const initialize = (readModelNames) => {
    const log = getLogger('RM/Lifecycle', 'SYS');
    readModelNames.forEach((name) => {
      states[name] = 'idle';
    });
    log.info(
      `Initialized lifecycle for read models: ${readModelNames.join(', ')}`,
    );
    if (context.storage && context.storage.perRequest) {
      return context.storage
        .perRequest('SYS')
        .find('readmodel.state', {})
        .toArray()
        .then((docs) => {
          docs.forEach((doc) => {
            if (doc.replayInProgress && states[doc.name] !== undefined) {
              log.warn(
                `Read model '${doc.name}' has replayInProgress flag — setting to invalid`,
              );
              setState(doc.name, 'invalid', 'SYS');
            }
          });
        });
    }
    return Promise.resolve();
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
    if (current === 'idle') {
      log.info(`Read model '${readModelName}' already idle`);
      return;
    }
    if (current === 'invalid' && !context.developmentMode) {
      log.warn(
        `Cannot stop '${readModelName}' from invalid state (not in development mode)`,
      );
      return;
    }
    if (current === 'catchup') {
      context.projectionHandler.clearCatchupState(readModelName);
    }
    if (current === 'invalid') {
      log.info(
        `Clearing replayInProgress for '${readModelName}' (dev mode recovery from invalid)`,
      );
      context.storage
        .perRequest(correlationId || 'SYS')
        .updateOne(
          'readmodel.state',
          { name: readModelName },
          { $unset: { replayInProgress: '' } },
        );
    }
    log.info(`Stopping read model '${readModelName}'`);
    setState(readModelName, 'idle', correlationId);
  };

  const startReplay = (readModelName, correlationId) => {
    const log = getLogger('RM/Lifecycle', correlationId || 'SYS');
    const current = getState(readModelName);
    if (current !== 'idle') {
      return Promise.reject(
        new Error(
          `Cannot start replay for '${readModelName}' from state '${current}'`,
        ),
      );
    }
    context.projectionHandler.setReadModelReplayState(readModelName, true);
    // Reset in-memory timestamp — replay always starts from scratch.
    if (context.readModels[readModelName]) {
      context.readModels[readModelName].lastProjectedEventTimestamp = 0;
    }
    setState(readModelName, 'replay', correlationId);
    log.info(`Read model '${readModelName}' is now in replay mode`);
    return context.storage
      .perRequest(correlationId)
      .updateOne(
        'readmodel.state',
        { name: readModelName },
        { $set: { replayInProgress: true } },
      );
  };

  const replayDone = (readModelName, correlationId) => {
    const log = getLogger('RM/Lifecycle', correlationId || 'SYS');
    const current = getState(readModelName);
    if (current !== 'replay') {
      log.warn(`replayDone for '${readModelName}' but state is '${current}'`);
      return;
    }
    context.projectionHandler.clearReadModelReplayState(readModelName);
    setState(readModelName, 'replay-done', correlationId);
    log.info(`Read model '${readModelName}' replay done`);
    context.storage
      .perRequest(correlationId)
      .updateOne(
        'readmodel.state',
        { name: readModelName },
        { $unset: { replayInProgress: '' } },
      );
  };

  const activate = (readModelName, correlationId) => {
    const log = getLogger('RM/Lifecycle', correlationId || 'SYS');
    const current = getState(readModelName);
    if (current !== 'idle' && current !== 'replay-done') {
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
        setState(readModelName, 'idle', correlationId);
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

  const goLive = (readModelName, correlationId) => {
    const log = getLogger('RM/Lifecycle', correlationId || 'SYS');
    const current = getState(readModelName);
    if (!context.developmentMode) {
      log.error(
        `goLive rejected for '${readModelName}' — not in development mode`,
      );
      return Promise.reject(new Error('goLive requires development mode'));
    }
    if (current !== 'idle' && current !== 'replay-done') {
      return Promise.reject(
        new Error(
          `Cannot go live for '${readModelName}' from state '${current}'`,
        ),
      );
    }

    log.info(
      `Dev mode: activating '${readModelName}' directly to live (skip catch-up)`,
    );

    if (!connectPromise) {
      connectPromise = context.connectEventBus().catch((err) => {
        connectPromise = null;
        throw err;
      });
    }

    return connectPromise.then(() => {
      setState(readModelName, 'live', correlationId);
      log.info(`Read model '${readModelName}' is now live (skipped catch-up)`);
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
    goLive,
    isValidTransition,
  };
};

export const __testing__ = {
  VALID_STATES,
  BASE_TRANSITIONS,
  DEV_TRANSITIONS,
};
