import expressApp from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import { getLogger } from '@lazyapps/logger';
import { createReplayHandler } from '@lazyapps/command-processor/replayHandler.js';
import {
  installReplayAdminApi,
  installReadModelAdminApi,
} from '@lazyapps/admin-api';

const log = getLogger('BS/Admin', 'INIT');

export const startAdmin = (
  correlationConfig,
  { port = 3005, eventStore, readModelStorage, eventBus, backup, readModels },
) => {
  log.info('Initializing admin service');

  return Promise.all([eventStore(), readModelStorage()])
    .then(([eventStoreInstance, storageInstance]) => {
      const context = {
        correlationConfig,
        eventStore: eventStoreInstance,
        storage: storageInstance,
        readModels,
      };

      return eventBus()
        .then((eventBusInstance) => ({
          ...context,
          eventBus: eventBusInstance,
        }))
        .then((ctx) => ({
          ...ctx,
          replayHandler: createReplayHandler(ctx.eventStore, ctx.eventBus),
        }))
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
      const app = expressApp();
      app.use(cors());
      app.use(bodyParser.json());

      installReplayAdminApi(context)(app);
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
