import { getLogger } from '@lazyapps/logger';
import { nanoid } from 'nanoid';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const createActivator = ({ eventBus, correlationConfig, token }) => {
  const queryReadModelState = (readModelName) => {
    const correlationId = `${correlationConfig?.serviceId || 'ADM'}-${nanoid()}`;
    const log = getLogger('Admin/Activator', correlationId);

    const replyTopic = `__admin_reply/${nanoid()}`;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(
            `Timed out waiting for query_state reply for '${readModelName}'`,
          ),
        );
      }, 5000);

      eventBus
        .subscribeAdminReply(replyTopic, (payload) => {
          clearTimeout(timeout);
          const rm = readModelName
            ? payload.readModels.find((r) => r.name === readModelName)
            : payload.readModels[0];
          if (!rm) {
            reject(
              new Error(
                `Read model '${readModelName}' not found in query_state response`,
              ),
            );
            return;
          }
          log.debug(
            `Read model '${readModelName}' state: ${JSON.stringify(rm)}`,
          );
          resolve(rm);
        })
        .then(() => {
          eventBus.publishAdminInstruction(correlationId)({
            type: 'query_state',
            targetReadModel: readModelName,
            replyTopic,
            ...(token && { token }),
            correlationId,
          });
        });
    });
  };

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
        // Step 3: Query RM state via event bus
        log.info(`Querying RM state via event bus for '${readModelName}'`);
        return queryReadModelState(readModelName);
      })
      .then((rm) => {
        const fromTimestamp = rm.lastProjectedEventTimestamp || 0;
        log.info(
          `Read model '${readModelName}' fromTimestamp: ${fromTimestamp}, state: ${rm.state || 'unknown'}`,
        );
        return fromTimestamp;
      })
      .then((fromTimestamp) => {
        // Step 4: Start catch-up via event bus
        const catchupCorrelationId = `${correlationConfig?.serviceId || 'ADM'}-${nanoid()}`;
        log.info(
          `Starting catch-up for '${readModelName}' from ${fromTimestamp}`,
        );
        eventBus.publishAdminInstruction(catchupCorrelationId)({
          type: 'start_catchup',
          readModel: readModelName,
          fromTimestamp,
          serviceId: correlationConfig?.serviceId,
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
  };
};
