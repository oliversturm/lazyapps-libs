import expressApp from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import { getLogger } from '@lazyapps/logger';
import {
  installAdminRoutes,
  createSseClient,
  createOrchestrator,
} from '@lazyapps/admin-api';
import { adminTokenAuth } from '@lazyapps/admin-api/adminTokenAuth.js';
import { createActivator } from './activator.js';

const log = getLogger('BS/Admin', 'INIT');

export const startAdmin = (
  correlationConfig,
  {
    port = 3005,
    eventBus,
    autoActivate,
    token,
    readModelServiceUrl,
    commandProcessorUrl,
    developmentMode,
    sseIdleGraceMs,
    sseHeartbeatMs,
  },
) => {
  log.info('Initializing admin service');

  return eventBus()
    .then((eventBusInstance) => {
      // Create SSE client for subscribing to RM and CP SSE streams.
      // Connections are established on demand (first browser SSE connect
      // or admin operation) and torn down again after an idle grace period.
      const sseClient = createSseClient({
        readModelServiceUrl,
        commandProcessorUrl,
        token,
        idleGraceMs: sseIdleGraceMs,
      });

      // Create orchestrator for replay/catchup sequences
      const orchestrator = createOrchestrator({
        sseClient,
        eventBus: eventBusInstance,
        token,
      });

      const app = expressApp();
      app.use(cors());
      app.use(bodyParser.json());
      app.use(adminTokenAuth(token));

      // Install new consolidated admin routes
      installAdminRoutes({
        sseClient,
        orchestrator,
        eventBus: eventBusInstance,
        token,
        developmentMode,
        heartbeatMs: sseHeartbeatMs,
      })(app);

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
                server.__testing__ = {
                  sseClient,
                  orchestrator,
                  eventBus: eventBusInstance,
                };

                // Wrap close to disconnect SSE before shutting down
                if (typeof server.close === 'function') {
                  const originalClose = server.close.bind(server);
                  server.close = (cb) => {
                    sseClient.disconnectAll();
                    return originalClose(cb);
                  };
                }

                // SSE subscriptions are on-demand (see admin architecture
                // spec section 9): they come up with the first browser SSE
                // connect or admin operation, and are torn down again when
                // idle. No eager connect here.
                log.info(
                  'Admin SSE subscriptions are on-demand — not connecting at startup',
                );

                // Auto-activate read models after server is listening
                if (autoActivate && readModelServiceUrl) {
                  const activator = createActivator({
                    sseClient,
                    orchestrator,
                    token,
                    readModelServiceUrl,
                  });

                  activator.autoActivateAll().catch((err) => {
                    log.error(`Auto-activation failed: ${err.message}`);
                  });
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
