import { getLogger } from '@lazyapps/logger';
import { initializeContext } from './context.js';

const createAdminInstructionHandler =
  (context) => (correlationId, instruction) => {
    const log = getLogger('RM/Admin', correlationId);
    const { type, targetReadModel } = instruction;
    const lm = context.lifecycleManager;

    if (!lm) {
      log.warn(
        'Received admin instruction but no lifecycle manager configured',
      );
      return;
    }

    log.info(
      `Admin instruction: ${type} for read model '${targetReadModel || 'all'}'`,
    );

    switch (type) {
      case 'activate':
        if (!targetReadModel) {
          log.warn('Activate instruction missing targetReadModel');
          return;
        }
        lm.activate(targetReadModel, correlationId).catch((err) => {
          log.error(`Failed to activate '${targetReadModel}': ${err.message}`);
        });
        break;

      case 'stop':
        if (!targetReadModel) {
          log.warn('Stop instruction missing targetReadModel');
          return;
        }
        lm.stop(targetReadModel, correlationId);
        break;

      case 'restart':
        if (!targetReadModel) {
          log.warn('Restart instruction missing targetReadModel');
          return;
        }
        lm.stop(targetReadModel, correlationId);
        lm.activate(targetReadModel, correlationId).catch((err) => {
          log.error(`Failed to restart '${targetReadModel}': ${err.message}`);
        });
        break;

      case 'query_state': {
        const { replyTopic } = instruction;
        if (!replyTopic) {
          log.warn('query_state instruction missing replyTopic');
          return;
        }
        const names = targetReadModel
          ? [targetReadModel]
          : Object.keys(context.readModels);
        const replayStates =
          context.projectionHandler.getReadModelReplayStates();
        const result = names.map((name) => {
          const rm = context.readModels[name];
          const base = {
            name,
            lastProjectedEventTimestamp: rm.lastProjectedEventTimestamp || 0,
            status: replayStates[name] ? 'replaying' : 'active',
            collections: rm.collections || [name],
          };
          if (lm) {
            base.state = lm.getState(name);
          }
          if (context.projectionHandler.getFifoQueueSize) {
            base.fifoQueueSize =
              context.projectionHandler.getFifoQueueSize(name);
          }
          return base;
        });
        log.info(
          `Responding to query_state on ${replyTopic} with ${result.length} read model(s)`,
        );
        if (context.publishAdminReply) {
          context.publishAdminReply(replyTopic, {
            correlationId,
            readModels: result,
          });
        }
        break;
      }

      default:
        log.warn(`Unknown admin instruction type: ${type}`);
    }
  };

export const startReadModels = (correlationConfig, config) =>
  initializeContext(correlationConfig, {
    readModels: config.readModels,
    storage: config.storage,
    eventBus: config.eventBus,
    changeNotificationSender: config.changeNotificationSender,
    commandSender: config.commandSender,
    backup: config.backup,
    lifecycle: config.lifecycle,
  }).then((context) => {
    if (context.lifecycleManager) {
      context.adminInstructionHandler = createAdminInstructionHandler(context);
    }
    if (config.token) {
      context.expectedAdminToken = config.token;
    }
    return config.listener(context);
  });
