import { createProjectionHandler } from './projections.js';
import { createSideEffectsHandler } from './sideEffects.js';
import { createChangeNotificationHandler } from './changeNotification.js';
import { createCommandHandler } from './commands.js';
import { createReadModelReplayHandler } from './replayHandler.js';
import { createLifecycleManager } from './lifecycleManager.js';
import { createCatchupHandler } from './catchupHandler.js';
import { createStatusTracker } from './statusTracker.js';
import { readTimestampFromBoth } from './secondaryTimestampStorage.js';
import { getLogger } from '@lazyapps/logger';

export const initializeContext = (
  correlationConfig,
  {
    readModels,
    storage,
    eventBus,
    changeNotificationSender,
    commandSender,
    backup,
    lifecycle,
    endpointName,
    secondaryTimestampStorage,
  },
) => {
  if (!endpointName) {
    const log = getLogger('RM/Context', 'INIT');
    log.warn(
      'No endpointName configured — replay/catchup filtering ' +
        'will not be scoped to this service instance',
    );
  }
  return storage()
    .then((storage) => ({
      storage,
      readModels,
      correlationConfig,
      ...(endpointName && { endpointName }),
    }))
    .then((context) => {
      if (secondaryTimestampStorage) {
        context.secondaryTimestampStorage = secondaryTimestampStorage;
      }
      return readTimestampFromBoth(
        context.storage,
        secondaryTimestampStorage,
      )(readModels)
        .then(() => context)
        .catch((err) => {
          const log = getLogger('RM/Context', 'INIT');
          log.error(`Failed to read timestamps from storage: ${err}`);
          context.storageUnreadable = true;
          return context;
        });
    })
    .then((context) => ({
      ...context,
      commands: createCommandHandler({ commandSender }),
    }))
    .then((context) =>
      createSideEffectsHandler().then((sideEffects) => ({
        ...context,
        sideEffects,
      })),
    )
    .then((context) => ({
      ...context,
      changeNotification: createChangeNotificationHandler(
        changeNotificationSender,
      ),
    }))
    .then((context) =>
      backup
        ? Promise.resolve({ ...context, backup: backup(context.storage) })
        : Promise.resolve(context),
    )
    .then((context) => {
      const statusTracker = createStatusTracker(readModels, endpointName);
      statusTracker.initialize(Object.keys(readModels));
      return { ...context, statusTracker };
    })
    .then((context) => ({
      ...context,
      projectionHandler: createProjectionHandler(context),
    }))
    .then((context) => ({
      ...context,
      replayHandler: createReadModelReplayHandler(context),
    }))
    .then((context) => {
      if (lifecycle) {
        const lifecycleManager = createLifecycleManager(context);
        context.lifecycleManager = lifecycleManager;
        context.catchupHandler = createCatchupHandler(context);

        // Signal to message bus: connect and subscribe to
        // __admin, __catchup, __replay topics on startup,
        // but defer the events topic subscription until activate().
        context.deferEventsSubscription = true;

        // connectEventBus subscribes to the events topic. Called by
        // lifecycleManager.activate() when a read model is activated.
        // The message bus implementation places subscribeToEvents() on
        // the context during initial connection.
        // Uses promise-caching to prevent duplicate subscriptions when
        // multiple read models activate concurrently.
        let subscribePromise = null;
        context.connectEventBus = () => {
          if (!context.subscribeToEvents) {
            return Promise.reject(
              new Error(
                'Message bus did not provide subscribeToEvents — ' +
                  'ensure the message bus supports deferred events subscription',
              ),
            );
          }
          if (!subscribePromise) {
            subscribePromise = context.subscribeToEvents().catch((err) => {
              subscribePromise = null;
              throw err;
            });
          }
          return subscribePromise;
        };

        return lifecycleManager
          .initialize(Object.keys(readModels))
          .then(() => {
            if (context.storageUnreadable) {
              const log = getLogger('RM/Context', 'INIT');
              Object.keys(readModels).forEach((name) => {
                log.warn(
                  `Setting '${name}' to invalid — primary storage was unreadable`,
                );
                lifecycleManager.setState(name, 'invalid', 'INIT');
              });
            }
          })
          .then(() => eventBus(context))
          .then(() => context);
      }
      return eventBus(context).then(() => context);
    });
};
