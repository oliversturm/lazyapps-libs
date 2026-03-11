import { createReplayHandler } from './replayHandler.js';
import { createCatchupHandler } from './catchupHandler.js';
import { getLogger } from '@lazyapps/logger';

export const initializeContext = (
  correlationConfig,
  { aggregateStore, eventStore, eventBus, aggregates, deferReady },
  handleCommand,
) => {
  // CP readiness: when deferReady is true, the CP starts not-ready
  // and waits for admin service to signal readiness via POST /admin/ready
  let ready = !deferReady;
  const log = getLogger('CP/Ready', 'SYS');
  if (deferReady) {
    log.info(
      'CP readiness deferred — waiting for admin service to signal ready',
    );
  }

  return (
    Promise.all([aggregateStore(aggregates), eventStore()])
      .then(([aggregateStore, eventStore]) => ({
        aggregates,
        aggregateStore,
        eventStore,
        handleCommand,
        correlationConfig,
        isReady: () => ready,
        setReady: (value) => {
          ready = value;
          log.info(`CP ready state set to ${value}`);
        },
      }))
      .then((context) =>
        eventBus().then((eventBus) => ({ ...context, eventBus })),
      )
      .then((context) => ({
        ...context,
        replayHandler: createReplayHandler(
          context.eventStore,
          context.eventBus,
        ),
        catchupHandler: createCatchupHandler(
          context.eventStore,
          context.eventBus,
        ),
      }))
      .then((context) => {
        if (context.eventBus.subscribeAdminMessages) {
          const adminLog = getLogger('CP/Admin', 'SYS');
          context.eventBus.subscribeAdminMessages(
            (correlationId, instruction) => {
              const log = getLogger('CP/Admin', correlationId);
              switch (instruction.type) {
                case 'set_ready':
                  log.info('Received set_ready instruction');
                  context.setReady(true);
                  break;
                case 'start_catchup':
                  log.info(
                    `Received start_catchup for ${instruction.readModel} from ${instruction.fromTimestamp || 0}`,
                  );
                  context.catchupHandler
                    .startCatchup(
                      correlationId,
                      instruction.readModel,
                      instruction.fromTimestamp || 0,
                    )
                    .catch((err) => {
                      log.error(
                        `Catch-up failed for ${instruction.readModel}: ${err}`,
                      );
                    });
                  break;
                case 'cancel_catchup':
                  log.info(
                    `Received cancel_catchup for ${instruction.readModel}`,
                  );
                  context.catchupHandler.cancelCatchup(
                    correlationId,
                    instruction.readModel,
                  );
                  break;
                case 'start_replay':
                  log.info(
                    `Received start_replay for ${instruction.readModel} from ${instruction.fromTimestamp || 0}`,
                  );
                  context.replayHandler
                    .startReplay(
                      correlationId,
                      instruction.readModel,
                      instruction.fromTimestamp || 0,
                      instruction.toTimestamp || null,
                      instruction.targetServiceId,
                    )
                    .catch((err) => {
                      log.error(
                        `Replay failed for ${instruction.readModel}: ${err}`,
                      );
                    });
                  break;
                case 'cancel_replay':
                  log.info(
                    `Received cancel_replay for ${instruction.readModel}`,
                  );
                  context.replayHandler.cancelReplay(
                    correlationId,
                    instruction.readModel,
                  );
                  break;
                default:
                  log.debug(
                    `Ignoring admin instruction type: ${instruction.type}`,
                  );
              }
            },
          );
          adminLog.info('Subscribed to admin messages on event bus');
        }
        return context;
      })
      // We run a full replay on startup, to get all aggregates
      // up and running. Not a great idea for production.
      .then((context) =>
        context.eventStore
          .replay('INIT' /*correlationId*/)(context)
          .then(() => context),
      )
  );
};
