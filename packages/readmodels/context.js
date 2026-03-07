import { createProjectionHandler } from './projections.js';
import { createSideEffectsHandler } from './sideEffects.js';
import { createChangeNotificationHandler } from './changeNotification.js';
import { createCommandHandler } from './commands.js';
import { createReadModelReplayHandler } from './replayHandler.js';
import { createLifecycleManager } from './lifecycleManager.js';
import { createCatchupHandler } from './catchupHandler.js';

export const initializeContext = (
  correlationConfig,
  {
    readModels,
    storage,
    eventBus,
    changeNotificationSender,
    commandSender,
    backup,
    catchupServiceUrl,
    autoActivate,
  },
) =>
  storage()
    .then((storage) => ({ storage, readModels, correlationConfig }))
    .then((context) =>
      context.storage
        .readLastProjectedEventTimestamps(readModels)
        .then(() => context),
    )
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
    .then((context) => ({
      ...context,
      projectionHandler: createProjectionHandler(context),
    }))
    .then((context) => ({
      ...context,
      replayHandler: createReadModelReplayHandler(context),
    }))
    .then((context) => {
      if (catchupServiceUrl) {
        const lifecycleManager = createLifecycleManager(context, {
          catchupServiceUrl,
        });
        context.lifecycleManager = lifecycleManager;
        context.catchupHandler = createCatchupHandler(context);
        context.connectEventBus = () => eventBus(context);
        lifecycleManager.initialize(Object.keys(readModels));
        context.autoActivate = autoActivate;
        return context;
      }
      return eventBus(context).then(() => context);
    });
