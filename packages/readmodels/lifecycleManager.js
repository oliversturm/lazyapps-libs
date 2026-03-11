import { getLogger } from '@lazyapps/logger';

const VALID_STATES = [
  'waiting',
  'activating',
  'catching-up',
  'live',
  'stopped',
];

export const createLifecycleManager = (context) => {
  const states = {};
  let connectPromise = null;

  const initialize = (readModelNames) => {
    const log = getLogger('RM/Lifecycle', 'SYS');
    readModelNames.forEach((name) => {
      states[name] = 'waiting';
    });
    log.info(
      `Initialized lifecycle for read models: ${readModelNames.join(', ')}`,
    );
  };

  const getState = (name) => states[name] || 'unknown';

  const setState = (name, state, correlationId) => {
    const log = getLogger('RM/Lifecycle', correlationId || 'SYS');
    const prev = states[name];
    states[name] = state;
    log.info(`Read model '${name}': ${prev} -> ${state}`);
  };

  const activate = (readModelName, correlationId) => {
    const log = getLogger('RM/Lifecycle', correlationId || 'SYS');
    const current = getState(readModelName);
    if (current !== 'waiting' && current !== 'stopped') {
      return Promise.reject(
        new Error(`Cannot activate '${readModelName}' from state '${current}'`),
      );
    }

    setState(readModelName, 'activating', correlationId);
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
        setState(readModelName, 'catching-up', correlationId);
        log.info(`Read model '${readModelName}' is now catching up`);
      })
      .catch((err) => {
        log.error(`Activation failed for ${readModelName}: ${err}`);
        context.projectionHandler.clearCatchupState(readModelName);
        setState(readModelName, 'waiting', correlationId);
        throw err;
      });
  };

  const stop = (readModelName, correlationId) => {
    const log = getLogger('RM/Lifecycle', correlationId || 'SYS');
    log.info(`Stopping read model '${readModelName}'`);
    setState(readModelName, 'stopped', correlationId);
  };

  return {
    initialize,
    getState,
    setState,
    activate,
    stop,
  };
};

export const __testing__ = { VALID_STATES };
