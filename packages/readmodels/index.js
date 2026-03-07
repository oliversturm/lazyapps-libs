import { initializeContext } from './context.js';

export const startReadModels = (correlationConfig, config) =>
  initializeContext(correlationConfig, {
    readModels: config.readModels,
    storage: config.storage,
    eventBus: config.eventBus,
    changeNotificationSender: config.changeNotificationSender,
    commandSender: config.commandSender,
    backup: config.backup,
    catchupServiceUrl: config.catchupServiceUrl,
    autoActivate: config.autoActivate,
  }).then((context) => {
    if (context.autoActivate && context.lifecycleManager) {
      Object.keys(config.readModels).forEach((name) => {
        context.lifecycleManager.autoActivateWithRetry(name);
      });
    }
    return config.listener(context);
  });
