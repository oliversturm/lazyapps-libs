import { getLogger } from '@lazyapps/logger';

const VALID_STATES = [
  'waiting',
  'activating',
  'catching-up',
  'live',
  'stopped',
];

export const createLifecycleManager = (context, { catchupServiceUrl }) => {
  const states = {};
  let eventBusConnected = false;

  const initialize = (readModelNames) => {
    readModelNames.forEach((name) => {
      states[name] = 'waiting';
    });
  };

  const getState = (name) => states[name] || 'unknown';

  const setState = (name, state) => {
    const log = getLogger('RM/Lifecycle', 'SYS');
    const prev = states[name];
    states[name] = state;
    log.info(`Read model '${name}': ${prev} -> ${state}`);
  };

  const activate = (readModelName) => {
    const log = getLogger('RM/Lifecycle', 'SYS');
    const current = getState(readModelName);
    if (current !== 'waiting' && current !== 'stopped') {
      return Promise.reject(
        new Error(`Cannot activate '${readModelName}' from state '${current}'`),
      );
    }

    setState(readModelName, 'activating');

    const connectEventBus = eventBusConnected
      ? Promise.resolve()
      : context.connectEventBus().then(() => {
          eventBusConnected = true;
        });

    return connectEventBus
      .then(() => {
        context.projectionHandler.setReadModelCatchingUp(readModelName);
        setState(readModelName, 'catching-up');

        const fromTimestamp =
          context.readModels[readModelName].lastProjectedEventTimestamp || 0;

        return fetch(
          `${catchupServiceUrl}/admin/catchup/${readModelName}/start`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              fromTimestamp,
              serviceId: context.correlationConfig.serviceId,
            }),
          },
        );
      })
      .then((response) => {
        if (!response.ok) {
          throw new Error(
            `Catch-up request failed: ${response.status} ${response.statusText}`,
          );
        }
        log.info(`Catch-up started for ${readModelName}`);
      })
      .catch((err) => {
        log.error(`Activation failed for ${readModelName}: ${err}`);
        context.projectionHandler.clearCatchupState(readModelName);
        setState(readModelName, 'waiting');
        throw err;
      });
  };

  const stop = (readModelName) => {
    setState(readModelName, 'stopped');
  };

  const autoActivateWithRetry = (readModelName, maxRetries = 10) => {
    const log = getLogger('RM/AutoActivate', 'SYS');
    let attempt = 0;
    const tryActivate = () =>
      activate(readModelName).catch((err) => {
        attempt++;
        if (attempt >= maxRetries) {
          log.error(
            `Auto-activation failed for ${readModelName} after ${maxRetries} attempts`,
          );
          return;
        }
        const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
        log.warn(
          `Auto-activation attempt ${attempt} failed for ${readModelName}, ` +
            `retrying in ${delay}ms: ${err}`,
        );
        return new Promise((resolve) => setTimeout(resolve, delay)).then(
          tryActivate,
        );
      });
    return tryActivate();
  };

  return {
    initialize,
    getState,
    setState,
    activate,
    stop,
    autoActivateWithRetry,
  };
};

export const __testing__ = { VALID_STATES };
