import { getLogger } from '@lazyapps/logger';
import { nanoid } from 'nanoid';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchJson = (url, options) =>
  fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  }).then((res) => {
    if (!res.ok) {
      return res.text().then((text) => {
        throw new Error(`HTTP ${res.status}: ${text}`);
      });
    }
    return res.json();
  });

const getReadModelServiceUrl = (adminReadModelServices, readModelName) => {
  if (typeof adminReadModelServices === 'string') {
    adminReadModelServices = JSON.parse(adminReadModelServices);
  }
  return (
    adminReadModelServices[readModelName] ||
    adminReadModelServices.default ||
    null
  );
};

// A7: Known interaction — if BOTH jwtSecret (express-jwt on runExpress) AND
// a plain admin token are configured, the activator's plain Bearer token will
// be rejected by express-jwt on CP /admin/ready endpoints. This is a
// pre-existing architectural conflict: the CP command express app applies
// express-jwt globally when jwtSecret is set, but the admin activator sends
// a plain shared-secret Bearer token. Resolving this requires either
// separating the admin endpoints onto a different Express app or exempting
// /admin routes from express-jwt. Out of scope for the current implementation.
export const createActivator = ({
  eventBus,
  adminReadModelServices,
  commandProcessorUrl,
  correlationConfig,
  token,
}) => {
  const activateReadModel = (readModelName) => {
    const correlationId = `${correlationConfig?.serviceId || 'ADM'}-${nanoid()}`;
    const log = getLogger('Admin/Activator', correlationId);

    log.info(`Starting activation orchestration for '${readModelName}'`);

    // Step 1: Publish "activate" instruction via message bus __admin topic
    eventBus.publishAdminInstruction(correlationId)({
      type: 'activate',
      targetReadModel: readModelName,
      ...(token && { token }),
      correlationId,
    });
    log.info(
      `Published activate instruction for '${readModelName}' on __admin topic`,
    );

    // Step 2: Wait briefly for RM to process activation
    return delay(200)
      .then(() => {
        // Step 3: Query RM's HTTP endpoint to get fromTimestamp
        const rmUrl = getReadModelServiceUrl(
          adminReadModelServices,
          readModelName,
        );
        if (!rmUrl) {
          throw new Error(
            `No read model service URL configured for '${readModelName}'`,
          );
        }

        log.info(`Querying RM state at ${rmUrl}/admin/readmodels`);
        const headers = {};
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }
        return fetchJson(`${rmUrl}/admin/readmodels`, { headers });
      })
      .then((readModels) => {
        const rm = readModels.find((r) => r.name === readModelName);
        if (!rm) {
          throw new Error(
            `Read model '${readModelName}' not found in RM service response`,
          );
        }
        const fromTimestamp = rm.lastProjectedEventTimestamp || 0;
        log.info(
          `Read model '${readModelName}' fromTimestamp: ${fromTimestamp}, state: ${rm.state || 'unknown'}`,
        );
        return fromTimestamp;
      })
      .then((fromTimestamp) => {
        // Step 4: Call CP's catch-up endpoint via HTTP
        log.info(
          `Starting catch-up on CP for '${readModelName}' from ${fromTimestamp}`,
        );
        const headers = {};
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }
        return fetchJson(
          `${commandProcessorUrl}/admin/catchup/${readModelName}/start`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify({
              fromTimestamp,
              serviceId: correlationConfig?.serviceId,
            }),
          },
        );
      })
      .then((result) => {
        log.info(
          `Catch-up started for '${readModelName}': ${JSON.stringify(result)}`,
        );
        return result;
      })
      .catch((err) => {
        log.error(
          `Activation orchestration failed for '${readModelName}': ${err.message}`,
        );
        throw err;
      });
  };

  const stopReadModel = (readModelName) => {
    const correlationId = `${correlationConfig?.serviceId || 'ADM'}-${nanoid()}`;
    const log = getLogger('Admin/Activator', correlationId);

    log.info(`Publishing stop instruction for '${readModelName}'`);
    eventBus.publishAdminInstruction(correlationId)({
      type: 'stop',
      targetReadModel: readModelName,
      ...(token && { token }),
      correlationId,
    });
  };

  const restartReadModel = (readModelName) => {
    const correlationId = `${correlationConfig?.serviceId || 'ADM'}-${nanoid()}`;
    const log = getLogger('Admin/Activator', correlationId);

    log.info(`Publishing restart instruction for '${readModelName}'`);
    eventBus.publishAdminInstruction(correlationId)({
      type: 'restart',
      targetReadModel: readModelName,
      ...(token && { token }),
      correlationId,
    });

    // After restart, the RM will re-enter waiting → activating → catching-up.
    // We need to re-orchestrate catch-up after a brief delay.
    return delay(500).then(() => activateReadModel(readModelName));
  };

  const queryReadModelState = (readModelName) => {
    const correlationId = `${correlationConfig?.serviceId || 'ADM'}-${nanoid()}`;
    const log = getLogger('Admin/Activator', correlationId);

    const rmUrl = getReadModelServiceUrl(adminReadModelServices, readModelName);
    if (!rmUrl) {
      return Promise.reject(
        new Error(
          `No read model service URL configured for '${readModelName}'`,
        ),
      );
    }

    const headers = {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    return fetchJson(`${rmUrl}/admin/readmodels`, { headers }).then(
      (readModels) => {
        const rm = readModels.find((r) => r.name === readModelName);
        if (!rm) {
          throw new Error(
            `Read model '${readModelName}' not found in RM service response`,
          );
        }
        log.debug(`Read model '${readModelName}' state: ${JSON.stringify(rm)}`);
        return rm;
      },
    );
  };

  const signalCpReady = () => {
    const correlationId = `${correlationConfig?.serviceId || 'ADM'}-${nanoid()}`;
    const log = getLogger('Admin/Activator', correlationId);

    log.info('Signaling CP readiness');
    const headers = {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    return fetchJson(`${commandProcessorUrl}/admin/ready`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ correlationId }),
    }).then((result) => {
      log.info(`CP readiness signaled: ${JSON.stringify(result)}`);
      return result;
    });
  };

  const autoActivateAll = (readModelNames) => {
    const log = getLogger('Admin/Activator', 'AUTO');
    log.info(`Auto-activating read models: ${readModelNames.join(', ')}`);

    const activateWithRetry = (name, attempt = 1, maxAttempts = 10) => {
      const retryLog = getLogger('Admin/Activator', `AUTO/${name}`);
      return activateReadModel(name).catch((err) => {
        if (attempt >= maxAttempts) {
          retryLog.error(
            `Auto-activation failed for '${name}' after ${maxAttempts} attempts: ${err.message}`,
          );
          throw err;
        }
        const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 30000);
        retryLog.warn(
          `Auto-activation attempt ${attempt} failed for '${name}', ` +
            `retrying in ${backoffMs}ms: ${err.message}`,
        );
        return delay(backoffMs).then(() =>
          activateWithRetry(name, attempt + 1, maxAttempts),
        );
      });
    };

    return Promise.all(readModelNames.map((name) => activateWithRetry(name)))
      .then(() => {
        log.info('All read models activated, waiting for live state');
        return waitForAllLive(readModelNames);
      })
      .then(() => {
        log.info('All auto-start read models are live, signaling CP ready');
        return signalCpReady();
      })
      .catch((err) => {
        log.error(`Auto-activation failed: ${err.message}`);
      });
  };

  const waitForAllLive = (readModelNames, maxWaitMs = 300000) => {
    const log = getLogger('Admin/Activator', 'AUTO/WAIT');
    const startTime = Date.now();

    const pollOnce = () => {
      if (Date.now() - startTime > maxWaitMs) {
        return Promise.reject(
          new Error(
            `Timed out waiting for read models to reach live state after ${maxWaitMs}ms`,
          ),
        );
      }

      return Promise.all(
        readModelNames.map((name) => queryReadModelState(name)),
      )
        .then((states) => {
          const allLive = states.every((s) => s.state === 'live');
          if (allLive) {
            log.info('All read models are live');
            return;
          }
          const summary = states
            .map((s) => `${s.name}=${s.state || 'unknown'}`)
            .join(', ');
          log.debug(`Waiting for live state: ${summary}`);
          return delay(2000).then(pollOnce);
        })
        .catch((err) => {
          log.warn(`Error polling RM states: ${err.message}, retrying...`);
          return delay(2000).then(pollOnce);
        });
    };

    return pollOnce();
  };

  return {
    activateReadModel,
    stopReadModel,
    restartReadModel,
    queryReadModelState,
    signalCpReady,
    autoActivateAll,
  };
};
