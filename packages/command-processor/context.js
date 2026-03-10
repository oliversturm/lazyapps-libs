import { createReplayHandler } from './replayHandler.js';
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
      }))
      // We run a full replay on startup, to get all aggregates
      // up and running. Not a great idea for production.
      .then((context) =>
        context.eventStore
          .replay('INIT' /*correlationId*/)(context)
          .then(() => context),
      )
  );
};
