import { createReplayHandler } from './replayHandler.js';
import { createCatchupHandler } from './catchupHandler.js';
import { createCpStatusTracker } from './cpStatusTracker.js';
import { getLogger } from '@lazyapps/logger';

export const initializeContext = (
  correlationConfig,
  { aggregateStore, eventStore, eventBus, aggregates },
  handleCommand,
) =>
  Promise.all([aggregateStore(aggregates), eventStore()])
    .then(([aggregateStore, eventStore]) => ({
      aggregates,
      aggregateStore,
      eventStore,
      handleCommand,
      correlationConfig,
    }))
    .then((context) =>
      eventBus().then((eventBus) => ({ ...context, eventBus })),
    )
    .then((context) => {
      const statusTracker = createCpStatusTracker();
      return {
        ...context,
        statusTracker,
        replayHandler: createReplayHandler(
          context.eventStore,
          context.eventBus,
          statusTracker,
        ),
        catchupHandler: createCatchupHandler(
          context.eventStore,
          context.eventBus,
          statusTracker,
        ),
      };
    })
    .then((context) => {
      if (context.eventBus.subscribeAdminMessages) {
        const adminLog = getLogger('CP/Admin', 'SYS');
        context.eventBus.subscribeAdminMessages(
          (correlationId, instruction) => {
            const log = getLogger('CP/Admin', correlationId);
            switch (instruction.type) {
              case 'replay':
                log.info(
                  `Received replay for ${instruction.readModel} from ${instruction.fromTimestamp || 0}`,
                );
                context.replayHandler
                  .startReplay(
                    correlationId,
                    instruction.readModel,
                    instruction.fromTimestamp || 0,
                    instruction.toTimestamp || null,
                    instruction.targetEndpointName,
                    instruction.replayRelevantEvents,
                  )
                  .catch((err) => {
                    log.error(
                      `Replay failed for ${instruction.readModel}: ${err}`,
                    );
                  });
                break;
              case 'cancelReplay':
                log.info(`Received cancelReplay for ${instruction.readModel}`);
                context.replayHandler.cancelReplay(
                  correlationId,
                  instruction.readModel,
                );
                break;
              case 'startCatchup':
                log.info(
                  `Received startCatchup for ${instruction.readModel} from ${instruction.fromTimestamp || 0}`,
                );
                context.catchupHandler
                  .startCatchup(
                    correlationId,
                    instruction.readModel,
                    instruction.fromTimestamp || 0,
                    instruction.targetEndpointName,
                    instruction.replayRelevantEvents,
                  )
                  .catch((err) => {
                    log.error(
                      `Catch-up failed for ${instruction.readModel}: ${err}`,
                    );
                  });
                break;
              case 'cancelCatchup':
                log.info(`Received cancelCatchup for ${instruction.readModel}`);
                context.catchupHandler.cancelCatchup(
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
        adminLog.info('Subscribed to admin messages on message bus');
      }
      return context;
    })
    // We run a full replay on startup, to get all aggregates
    // up and running. Not a great idea for production.
    .then((context) =>
      context.eventStore
        .replay('INIT' /*correlationId*/)(context)
        .then(() => context),
    );
