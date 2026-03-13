import { getLogger } from '@lazyapps/logger';
import { nanoid } from 'nanoid';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const parseIdentifier = (identifier) => {
  const slashIndex = identifier.indexOf('/');
  if (slashIndex === -1) {
    return { endpointName: null, readModelName: identifier };
  }
  return {
    endpointName: identifier.substring(0, slashIndex),
    readModelName: identifier.substring(slashIndex + 1),
  };
};

export const createActivator = ({
  eventBus,
  correlationConfig,
  token,
  readModelServiceUrl,
  queryRetries = 5,
  queryRetryDelayMs = 2000,
}) => {
  const discoveredReadModels = {};

  const getServiceUrls = () => {
    if (typeof readModelServiceUrl === 'string') {
      return [readModelServiceUrl];
    }
    if (typeof readModelServiceUrl === 'object' && readModelServiceUrl) {
      return [...new Set(Object.values(readModelServiceUrl))];
    }
    return [];
  };

  const fetchReadModels = (log) => {
    const urls = getServiceUrls();
    if (urls.length === 0) {
      return Promise.reject(
        new Error('readModelServiceUrl is required for queryReadModelState'),
      );
    }

    const headers = { 'Content-Type': 'application/json' };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    return Promise.all(
      urls.map((baseUrl) => {
        const url = `${baseUrl}/admin/readmodels`;
        return fetch(url, { headers })
          .then((response) => {
            if (!response.ok) {
              throw new Error(`HTTP ${response.status} from ${url}`);
            }
            return response.json();
          })
          .catch((err) => {
            log.warn(`Failed to query ${url}: ${err.message}`);
            return [];
          });
      }),
    ).then((results) => {
      const flat = results.flat();
      flat.forEach((rm) => {
        if (rm.name) {
          const key = rm.endpointName
            ? `${rm.endpointName}/${rm.name}`
            : rm.name;
          discoveredReadModels[key] = rm;
        }
      });
      return flat;
    });
  };

  const getDiscoveredReadModel = (name) => discoveredReadModels[name];

  const getDiscoveredReadModels = () => ({ ...discoveredReadModels });

  const queryReadModelState = (
    identifier,
    retries = queryRetries,
    retryDelayMs = queryRetryDelayMs,
  ) => {
    const { endpointName, readModelName } = parseIdentifier(identifier);
    const correlationId = `${correlationConfig?.serviceId || 'ADM'}-${nanoid()}`;
    const log = getLogger('Admin/Activator', correlationId);

    const matchesRm = (r) => {
      if (endpointName) {
        return r.name === readModelName && r.endpointName === endpointName;
      }
      return r.name === readModelName;
    };

    const attempt = (attemptsLeft) =>
      fetchReadModels(log).then((readModels) => {
        const rm = identifier ? readModels.find(matchesRm) : readModels[0];
        if (!rm && attemptsLeft > 0) {
          log.warn(
            `Read model '${identifier}' not found, retrying (${attemptsLeft} left)`,
          );
          return delay(retryDelayMs).then(() => attempt(attemptsLeft - 1));
        }
        if (!rm) {
          throw new Error(
            `Read model '${identifier}' not found in HTTP response`,
          );
        }
        log.debug(`Read model '${identifier}' state: ${JSON.stringify(rm)}`);
        return rm;
      });

    return attempt(retries);
  };

  const activateReadModel = (identifier) => {
    const { endpointName, readModelName } = parseIdentifier(identifier);
    const correlationId = `${correlationConfig?.serviceId || 'ADM'}-${nanoid()}`;
    const log = getLogger('Admin/Activator', correlationId);

    log.info(`Starting activation orchestration for '${identifier}'`);

    // Step 1: Publish "activate" instruction via message bus __admin topic
    eventBus.publishAdminInstruction(correlationId)({
      type: 'activate',
      targetReadModel: readModelName,
      ...(endpointName && { targetEndpointName: endpointName }),
      ...(token && { token }),
      correlationId,
    });
    log.info(
      `Published activate instruction for '${identifier}' on __admin topic`,
    );

    // Step 2: Wait briefly for RM to process activation
    return delay(200)
      .then(() => {
        // Step 3: Query RM state via HTTP
        log.info(`Querying RM state via HTTP for '${identifier}'`);
        return queryReadModelState(identifier);
      })
      .then((rm) => {
        const fromTimestamp = rm.lastProjectedEventTimestamp || 0;
        log.info(
          `Read model '${identifier}' fromTimestamp: ${fromTimestamp}, ` +
            `state: ${rm.state || 'unknown'}`,
        );
        return { fromTimestamp, rmEndpointName: rm.endpointName };
      })
      .then(({ fromTimestamp, rmEndpointName }) => {
        // Step 4: Start catch-up via event bus
        const catchupCorrelationId = `${correlationConfig?.serviceId || 'ADM'}-${nanoid()}`;
        log.info(`Starting catch-up for '${identifier}' from ${fromTimestamp}`);
        const ep = rmEndpointName || endpointName;
        eventBus.publishAdminInstruction(catchupCorrelationId)({
          type: 'start_catchup',
          readModel: readModelName,
          fromTimestamp,
          ...(ep && { targetEndpointName: ep }),
          ...(token && { token }),
          correlationId: catchupCorrelationId,
        });
        return {
          status: 'started',
          readModel: readModelName,
          correlationId: catchupCorrelationId,
        };
      })
      .then((result) => {
        log.info(
          `Catch-up started for '${identifier}': ` + JSON.stringify(result),
        );
        return result;
      })
      .catch((err) => {
        log.error(
          `Activation orchestration failed for '${identifier}': ` + err.message,
        );
        throw err;
      });
  };

  const stopReadModel = (identifier) => {
    const { endpointName, readModelName } = parseIdentifier(identifier);
    const correlationId = `${correlationConfig?.serviceId || 'ADM'}-${nanoid()}`;
    const log = getLogger('Admin/Activator', correlationId);

    log.info(`Publishing stop instruction for '${identifier}'`);
    eventBus.publishAdminInstruction(correlationId)({
      type: 'stop',
      targetReadModel: readModelName,
      ...(endpointName && { targetEndpointName: endpointName }),
      ...(token && { token }),
      correlationId,
    });
  };

  const restartReadModel = (identifier) => {
    const { endpointName, readModelName } = parseIdentifier(identifier);
    const correlationId = `${correlationConfig?.serviceId || 'ADM'}-${nanoid()}`;
    const log = getLogger('Admin/Activator', correlationId);

    log.info(`Publishing restart instruction for '${identifier}'`);
    eventBus.publishAdminInstruction(correlationId)({
      type: 'restart',
      targetReadModel: readModelName,
      ...(endpointName && { targetEndpointName: endpointName }),
      ...(token && { token }),
      correlationId,
    });

    // After restart, the RM will re-enter waiting → activating → catching-up.
    // We need to re-orchestrate catch-up after a brief delay.
    return delay(500).then(() => activateReadModel(identifier));
  };

  const signalCpReady = () => {
    const correlationId = `${correlationConfig?.serviceId || 'ADM'}-${nanoid()}`;
    const log = getLogger('Admin/Activator', correlationId);

    log.info('Signaling CP readiness via event bus');
    eventBus.publishAdminInstruction(correlationId)({
      type: 'set_ready',
      ...(token && { token }),
      correlationId,
    });
    log.info('CP readiness signaled');
    return Promise.resolve({ status: 'ready' });
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
    getDiscoveredReadModel,
    getDiscoveredReadModels,
    fetchReadModels: () =>
      fetchReadModels(getLogger('Admin/Activator', 'DISCOVER')),
  };
};
