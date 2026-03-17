import { getLogger } from '@lazyapps/logger';
import { initializeContext } from './context.js';

export { installAdminEndpoints } from './adminEndpoints.js';

const handleCreateBackup = (context, correlationId, instruction) => {
  const log = getLogger('RM/Admin', correlationId);
  const { targetReadModel } = instruction;

  if (!context.backup) {
    log.error('Backup not configured on this RM service');
    return;
  }

  const rm = context.readModels[targetReadModel];
  const collectionNames = rm.collections || [targetReadModel];

  log.info(`Creating backup for ${targetReadModel}`);
  context.backup
    .createBackup(correlationId, targetReadModel, collectionNames)
    .then((result) => {
      if (context.statusTracker) {
        context.statusTracker.updateStatus(targetReadModel, {
          backupProgress: {
            state: 'idle',
            backupId: result.backupId,
          },
        });
        context.statusTracker.immediatePush(targetReadModel);
      }
    })
    .catch((err) => {
      log.error(`Failed to create backup: ${err}`);
      if (context.statusTracker) {
        context.statusTracker.updateStatus(targetReadModel, {
          backupProgress: { state: 'idle' },
        });
        context.statusTracker.immediatePush(targetReadModel);
      }
    });
};

const handleDeleteBackup = (context, correlationId, instruction) => {
  const log = getLogger('RM/Admin', correlationId);
  const { targetReadModel, backupId } = instruction;

  if (!context.backup) {
    log.error('Backup not configured on this RM service');
    return;
  }

  log.info(`Deleting backup ${backupId}`);
  context.backup
    .deleteBackup(correlationId, backupId)
    .then(() => {
      log.info(`Deleted backup ${backupId}`);
    })
    .catch((err) => {
      log.error(`Failed to delete backup: ${err}`);
    });
};

const handleRestoreBackup = (context, correlationId, instruction) => {
  const log = getLogger('RM/Admin', correlationId);
  const { targetReadModel, backupId } = instruction;

  if (!context.backup) {
    log.error('Backup not configured on this RM service');
    return;
  }

  log.info(`Restoring backup ${backupId} for ${targetReadModel}`);
  if (context.statusTracker) {
    context.statusTracker.updateStatus(targetReadModel, {
      backupProgress: { state: 'restoring', backupId },
    });
    context.statusTracker.immediatePush(targetReadModel);
  }

  context.backup
    .restoreBackup(correlationId, targetReadModel, backupId)
    .then(() => {
      log.info(`Restored backup ${backupId} for ${targetReadModel}`);
      if (context.statusTracker) {
        context.statusTracker.updateStatus(targetReadModel, {
          backupProgress: { state: 'idle', backupId },
        });
        context.statusTracker.immediatePush(targetReadModel);
      }
    })
    .catch((err) => {
      log.error(`Failed to restore backup: ${err}`);
      if (context.statusTracker) {
        context.statusTracker.updateStatus(targetReadModel, {
          backupProgress: { state: 'idle' },
        });
        context.statusTracker.immediatePush(targetReadModel);
      }
    });
};

const handleReset = (context, correlationId, instruction) => {
  const log = getLogger('RM/Admin', correlationId);
  const { targetReadModel } = instruction;
  const rm = context.readModels[targetReadModel];
  const collectionNames = rm.collections || [targetReadModel];

  log.info(`Resetting storage for ${targetReadModel}`);

  const resetOp = context.backup
    ? context.backup.clearCollections(
        correlationId,
        targetReadModel,
        collectionNames,
      )
    : context.storage
        .perRequest(correlationId)
        .dropCollection(targetReadModel)
        .then(() => Promise.resolve());

  resetOp
    .then(() => {
      log.info(`Reset complete for ${targetReadModel}`);
      if (context.statusTracker) {
        context.statusTracker.immediatePush(targetReadModel);
      }
    })
    .catch((err) => {
      log.error(`Failed to reset ${targetReadModel}: ${err}`);
    });
};

const createAdminInstructionHandler =
  (context) => (correlationId, instruction) => {
    const log = getLogger('RM/Admin', correlationId);
    const { type, targetReadModel } = instruction;
    const lm = context.lifecycleManager;

    log.info(
      `Admin instruction: ${type} for read model '${targetReadModel || 'all'}'`,
    );

    switch (type) {
      case 'activate':
        if (!lm) {
          log.warn('Activate requires lifecycle manager');
          return;
        }
        if (!targetReadModel) {
          log.warn('Activate instruction missing targetReadModel');
          return;
        }
        lm.activate(targetReadModel, correlationId).catch((err) => {
          log.error(`Failed to activate '${targetReadModel}': ${err.message}`);
        });
        break;

      case 'stop':
        if (!lm) {
          log.warn('Stop requires lifecycle manager');
          return;
        }
        if (!targetReadModel) {
          log.warn('Stop instruction missing targetReadModel');
          return;
        }
        lm.stop(targetReadModel, correlationId);
        break;

      case 'startReplay':
        if (!lm) {
          log.warn('startReplay requires lifecycle manager');
          return;
        }
        if (!targetReadModel) {
          log.warn('startReplay instruction missing targetReadModel');
          return;
        }
        lm.startReplay(targetReadModel, correlationId).catch((err) => {
          log.error(
            `Failed to start replay for '${targetReadModel}': ${err.message}`,
          );
        });
        break;

      case 'replayDone':
        if (!lm) {
          log.warn('replayDone requires lifecycle manager');
          return;
        }
        if (!targetReadModel) {
          log.warn('replayDone instruction missing targetReadModel');
          return;
        }
        lm.replayDone(targetReadModel, correlationId);
        break;

      case 'catchupDone': {
        if (!lm) {
          log.warn('catchupDone requires lifecycle manager');
          return;
        }
        if (!targetReadModel) {
          log.warn('catchupDone instruction missing targetReadModel');
          return;
        }
        const toTimestamp = instruction.toTimestamp || 0;
        lm.catchupDone(targetReadModel, toTimestamp, correlationId).catch(
          (err) => {
            log.error(
              `Failed to complete catch-up for '${targetReadModel}': ${err.message}`,
            );
          },
        );
        break;
      }

      case 'reset':
        if (!targetReadModel) {
          log.warn('reset instruction missing targetReadModel');
          return;
        }
        handleReset(context, correlationId, instruction);
        break;

      case 'createBackup':
        if (!targetReadModel) {
          log.warn('createBackup instruction missing targetReadModel');
          return;
        }
        if (context.statusTracker) {
          context.statusTracker.updateStatus(targetReadModel, {
            backupProgress: { state: 'creating' },
          });
          context.statusTracker.immediatePush(targetReadModel);
        }
        handleCreateBackup(context, correlationId, instruction);
        break;

      case 'cancelBackup':
        if (!targetReadModel) {
          log.warn('cancelBackup instruction missing targetReadModel');
          return;
        }
        log.info(`Cancel backup for ${targetReadModel}`);
        if (context.statusTracker) {
          context.statusTracker.updateStatus(targetReadModel, {
            backupProgress: { state: 'idle' },
          });
          context.statusTracker.immediatePush(targetReadModel);
        }
        break;

      case 'deleteBackup':
        if (!targetReadModel) {
          log.warn('deleteBackup instruction missing targetReadModel');
          return;
        }
        handleDeleteBackup(context, correlationId, instruction);
        break;

      case 'restoreBackup':
        if (!targetReadModel) {
          log.warn('restoreBackup instruction missing targetReadModel');
          return;
        }
        handleRestoreBackup(context, correlationId, instruction);
        break;

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
    endpointName: config.endpointName,
  }).then((context) => {
    context.adminInstructionHandler = createAdminInstructionHandler(context);
    if (config.token) {
      context.expectedAdminToken = config.token;
    }
    return config.listener(context);
  });
