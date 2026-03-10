import expressApp from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import { getLogger } from '@lazyapps/logger';
import { createReplayHandler } from '@lazyapps/command-processor/replayHandler.js';

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
  return {
    getReadModelReplayStates: () => replayStates,
    isReadModelReplaying: (name) => !!replayStates[name],
    setReadModelReplayState: (name, state) => {
      replayStates[name] = state;
    },
    clearReadModelReplayState: (name) => {
      delete replayStates[name];
    },
  };
};

export const startAdmin = (
  correlationConfig,
  {
    port = 3005,
    eventStore,
    readModelStorage,
    eventBus,
    backup,
    readModels,
    autoActivate,
    token,
  },
) => {
  log.info('Initializing admin service');

  return Promise.all([eventStore(), readModelStorage()])
    .then(([eventStoreInstance, storageInstance]) => {
      const context = {
        correlationConfig,
        eventStore: eventStoreInstance,
        storage: storageInstance,
        readModels,
        projectionHandler: createAdminProjectionHandler(),
      };

      return eventBus()
        .then((eventBusInstance) => {
          const ctx = { ...context, eventBus: eventBusInstance };
          if (eventBusInstance.subscribeSystemMessages) {
            return Promise.resolve(
              eventBusInstance.subscribeSystemMessages((msg) => {
                if (
                  msg.type === 'REPLAY_EVENTS_DONE' ||
                  msg.type === 'REPLAY_CANCELLED'
                ) {
                  context.projectionHandler.clearReadModelReplayState(
                    msg.readModel,
                  );
                }
                if (
                  msg.type === 'CATCHUP_EVENTS_DONE' ||
                  msg.type === 'CATCHUP_CANCELLED'
                ) {
                  log.info(`Catch-up ${msg.type} for ${msg.readModel}`);
                }
              }),
            ).then(() => ctx);
          }
          return ctx;
        })
        .then((ctx) => ({
          ...ctx,
          replayHandler: createReplayHandler(ctx.eventStore, ctx.eventBus),
        }))
        .then((ctx) => {
          if (ctx.eventBus.subscribeAdminMessages) {
            return Promise.resolve(
              ctx.eventBus.subscribeAdminMessages(
                (correlationId, instruction) => {
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
                    case 'set_ready':
                      log.info(
                        'Received set_ready instruction (admin service — no-op)',
                      );
                      break;
                  }
                },
              ),
            ).then(() => ctx);
          }
          return ctx;
        })
        .then((ctx) => (backup ? { ...ctx, backup: backup(ctx.storage) } : ctx))
        .then((ctx) =>
          storageInstance.readLastProjectedEventTimestamps
            ? storageInstance
                .readLastProjectedEventTimestamps(readModels)
                .then(() => ctx)
            : ctx,
        );
    })
    .then((context) => {
      // Create activator for orchestration via event bus
      const activator = createActivator({
        eventBus: context.eventBus,
        correlationConfig,
        token,
      });

      context.activator = activator;

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
                if (autoActivate) {
                  const rmNames =
                    autoActivate === true
                      ? Object.keys(readModels)
                      : Array.isArray(autoActivate)
                        ? autoActivate
                        : Object.keys(readModels);

                  log.info(
                    `Auto-activation configured for: ${rmNames.join(', ')}`,
                  );
                  activator.autoActivateAll(rmNames);
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
