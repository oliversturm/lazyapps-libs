import expressApp from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import { getLogger } from '@lazyapps/logger';
import {
  installReplayAdminApi,
  installReadModelAdminApi,
  installCatchupAdminApi,
} from '@lazyapps/admin-api';
import { adminTokenAuth } from '@lazyapps/admin-api/adminTokenAuth.js';
import { createActivator } from './activator.js';

const log = getLogger('BS/Admin', 'INIT');

const createAdminProjectionHandler = () => {
  const replayStates = {};
  const terminalStates = {};
  return {
    getReadModelReplayStates: () => replayStates,
    isReadModelReplaying: (name) => !!replayStates[name],
    setReadModelReplayState: (name, state) => {
      replayStates[name] = state;
      delete terminalStates[name];
    },
    clearReadModelReplayState: (name) => {
      delete replayStates[name];
    },
    getReadModelTerminalStatus: (name) => terminalStates[name] || null,
    setReadModelTerminalStatus: (name, status) => {
      terminalStates[name] = status;
    },
  };
};

export const startAdmin = (
  correlationConfig,
  {
    port = 3005,
    eventBus,
    readModels,
    autoActivate,
    token,
    readModelServiceUrl,
  },
) => {
  log.info('Initializing admin service');

  const context = {
    correlationConfig,
    readModels: readModels || {},
    projectionHandler: createAdminProjectionHandler(),
  };

  return eventBus()
    .then((eventBusInstance) => {
      const ctx = { ...context, eventBus: eventBusInstance };
      if (eventBusInstance.subscribeSystemMessages) {
        return Promise.resolve(
          eventBusInstance.subscribeSystemMessages((msg) => {
            if (msg.type === 'REPLAY_EVENTS_DONE') {
              const key = msg.targetEndpointName
                ? `${msg.targetEndpointName}/${msg.readModel}`
                : msg.readModel;
              log.info(`Replay ${msg.type} for ${key}`);
              context.projectionHandler.clearReadModelReplayState(key);
              context.projectionHandler.setReadModelTerminalStatus(
                key,
                'completed',
              );
            }
            if (msg.type === 'REPLAY_CANCELLED') {
              const key = msg.targetEndpointName
                ? `${msg.targetEndpointName}/${msg.readModel}`
                : msg.readModel;
              log.info(`Replay ${msg.type} for ${key}`);
              context.projectionHandler.clearReadModelReplayState(key);
              context.projectionHandler.setReadModelTerminalStatus(
                key,
                'cancelled',
              );
            }
            if (msg.type === 'CATCHUP_EVENTS_DONE') {
              const key = msg.targetEndpointName
                ? `${msg.targetEndpointName}/${msg.readModel}`
                : msg.readModel;
              log.info(`Catch-up ${msg.type} for ${key}`);
              context.projectionHandler.setReadModelTerminalStatus(
                key,
                'completed',
              );
            }
            if (msg.type === 'CATCHUP_CANCELLED') {
              const key = msg.targetEndpointName
                ? `${msg.targetEndpointName}/${msg.readModel}`
                : msg.readModel;
              log.info(`Catch-up ${msg.type} for ${key}`);
              context.projectionHandler.setReadModelTerminalStatus(
                key,
                'cancelled',
              );
            }
          }),
        ).then(() => ctx);
      }
      return ctx;
    })
    .then((ctx) => {
      if (ctx.eventBus.subscribeAdminMessages) {
        return Promise.resolve(
          ctx.eventBus.subscribeAdminMessages((correlationId, instruction) => {
            switch (instruction.type) {
              case 'start_catchup':
                log.info(
                  `Received start_catchup for ${instruction.readModel} (admin service — no-op, handled by CP)`,
                );
                break;
              case 'cancel_catchup':
                log.info(
                  `Received cancel_catchup for ${instruction.readModel} (admin service — no-op, handled by CP)`,
                );
                break;
              case 'start_replay':
                log.info(
                  `Received start_replay for ${instruction.readModel} (admin service — no-op, handled by CP)`,
                );
                break;
              case 'cancel_replay':
                log.info(
                  `Received cancel_replay for ${instruction.readModel} (admin service — no-op, handled by CP)`,
                );
                break;
              case 'create_backup':
              case 'list_backups':
              case 'delete_backup':
              case 'prepare_for_replay':
                log.info(
                  `Received ${instruction.type} for ${instruction.targetReadModel} (admin service — no-op, handled by RM)`,
                );
                break;
              case 'set_ready':
                log.info(
                  'Received set_ready instruction (admin service — no-op)',
                );
                break;
            }
          }),
        ).then(() => ctx);
      }
      return ctx;
    })
    .then((context) => {
      // Create activator for orchestration via event bus (requires
      // readModelServiceUrl to know which RM services to query)
      const activator = readModelServiceUrl
        ? createActivator({
            eventBus: context.eventBus,
            correlationConfig,
            token,
            readModelServiceUrl,
          })
        : null;

      if (activator) {
        context.activator = activator;
      }

      const app = expressApp();
      app.use(cors());
      app.use(bodyParser.json());
      app.use(adminTokenAuth(token));

      installReplayAdminApi(context)(app);
      installCatchupAdminApi(context)(app);
      installReadModelAdminApi(context)(app);

      return import('@lazyapps/admin-ui/build/handler.js')
        .then(({ handler }) => {
          app.use(handler);
          log.info('Admin UI mounted');
        })
        .catch(() => {
          log.info('Admin UI not available, serving API only');
        })
        .then(
          () =>
            new Promise((resolve, reject) => {
              const server = app.listen(port, '0.0.0.0');

              server.on('error', (err) => {
                log.error(`Admin server error: ${err}`);
                reject(err);
              });

              server.on('listening', () => {
                const addr = server.address();
                log.info(
                  `Admin server listening on ${addr.address}:${addr.port}`,
                );
                server.__testing__ = { context };

                // Auto-activate read models after server is listening
                if (autoActivate && activator) {
                  const explicitNames = Array.isArray(autoActivate)
                    ? autoActivate
                    : null;

                  if (explicitNames) {
                    log.info(
                      `Auto-activation configured for: ${explicitNames.join(', ')}`,
                    );
                    activator.autoActivateAll(explicitNames);
                  } else {
                    // Discover read models from RM services, then activate
                    // Retry with exponential backoff when services aren't ready yet
                    log.info(
                      'Auto-activation: discovering read models from services',
                    );
                    const maxAttempts = 15;
                    const delay = (ms) =>
                      new Promise((resolve) => setTimeout(resolve, ms));

                    const tryFetch = (attempt, backoff) =>
                      activator.fetchReadModels().then((rms) => {
                        if (rms.length === 0 && attempt < maxAttempts) {
                          log.warn(
                            `Read model discovery returned empty results (attempt ${attempt}/${maxAttempts}), retrying in ${backoff}ms`,
                          );
                          return delay(backoff).then(() =>
                            tryFetch(attempt + 1, Math.min(backoff * 2, 30000)),
                          );
                        }
                        return rms;
                      });

                    tryFetch(1, 1000)
                      .then((rms) => {
                        if (rms.length === 0) {
                          log.error(
                            'Read model discovery returned empty results after all retry attempts',
                          );
                          return;
                        }
                        const names = rms.map((rm) =>
                          rm.endpointName
                            ? `${rm.endpointName}/${rm.name}`
                            : rm.name,
                        );
                        log.info(`Discovered read models: ${names.join(', ')}`);
                        return activator.autoActivateAll(names);
                      })
                      .catch((err) => {
                        log.error(
                          `Failed to discover read models for auto-activation: ${err.message}`,
                        );
                      });
                  }
                }

                resolve(server);
              });
            }),
        );
    })
    .catch((err) => {
      log.error(`Failed to start admin service: ${err}`);
      throw err;
    });
};
