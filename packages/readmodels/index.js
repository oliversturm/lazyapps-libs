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

  // R14: Read secondary timestamp before restore (backup restore
  // overwrites primary storage, so we need the secondary value as
  // a safety net).
  const readSecondaryTs = context.secondaryTimestampStorage
    ? context.secondaryTimestampStorage.readTimestamp(targetReadModel)
    : Promise.resolve(0);

  readSecondaryTs
    .then((secondaryTs) => {
      // R5: Set replayInProgress BEFORE restore.
      return context.storage
        .perRequest(correlationId)
        .updateOne(
          'readmodel.state',
          { name: targetReadModel },
          { $set: { replayInProgress: true } },
        )
        .then(() =>
          context.backup.restoreBackup(
            correlationId,
            targetReadModel,
            backupId,
          ),
        )
        .then(() => {
          // R14: After restore, compare secondary with restored primary.
          // Write back the larger to both storages.
          const primaryTs =
            context.readModels[targetReadModel]?.lastProjectedEventTimestamp ||
            0;
          const bestTs = Math.max(primaryTs, secondaryTs);
          if (bestTs > primaryTs) {
            log.info(
              `Secondary timestamp (${secondaryTs}) > restored primary ` +
                `(${primaryTs}) — writing back ${bestTs}`,
            );
            return context.storage
              .updateLastProjectedEventTimestamps(
                correlationId,
                [targetReadModel],
                bestTs,
              )
              .then(() => {
                context.readModels[
                  targetReadModel
                ].lastProjectedEventTimestamp = bestTs;
              });
          }
          return bestTs;
        })
        .then((bestTs) => {
          // Ensure secondary has the best value
          if (context.secondaryTimestampStorage && bestTs > secondaryTs) {
            return context.secondaryTimestampStorage.writeTimestamp(
              targetReadModel,
              bestTs,
            );
          }
        });
    })
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

const handlePersistTimestamp = (context, correlationId, instruction) => {
  const log = getLogger('RM/Admin', correlationId);
  const { targetReadModel, timestamp } = instruction;

  log.info(`Persisting timestamp ${timestamp} for ${targetReadModel}`);

  const primaryWrite = context.storage
    .updateLastProjectedEventTimestamps(
      correlationId,
      [targetReadModel],
      timestamp,
    )
    .then(() => {
      if (context.readModels[targetReadModel]) {
        context.readModels[targetReadModel].lastProjectedEventTimestamp =
          timestamp;
      }
    });

  const secondaryWrite = context.secondaryTimestampStorage
    ? context.secondaryTimestampStorage.writeTimestamp(
        targetReadModel,
        timestamp,
      )
    : Promise.resolve();

  return Promise.all([primaryWrite, secondaryWrite])
    .then(() => {
      log.info(
        `Persisted timestamp ${timestamp} for ${targetReadModel} to both storages`,
      );
    })
    .catch((err) => {
      log.error(`Failed to persist timestamp for ${targetReadModel}: ${err}`);
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

    if (instruction.developmentOperation && !context.developmentMode) {
      log.error(
        `REJECTED: instruction '${type}' requires development mode ` +
          `but this RM service is NOT in development mode. ` +
          `This is a safety check — development operations are ` +
          `not allowed in production.`,
      );
      return;
    }

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

      case 'persistTimestamp':
        if (!targetReadModel) {
          log.warn('persistTimestamp instruction missing targetReadModel');
          return;
        }
        handlePersistTimestamp(context, correlationId, instruction);
        break;

      case 'dismissInvalid':
        if (!lm) {
          log.warn('dismissInvalid requires lifecycle manager');
          return;
        }
        if (!targetReadModel) {
          log.warn('dismissInvalid instruction missing targetReadModel');
          return;
        }
        lm.stop(targetReadModel, correlationId);
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
    secondaryTimestampStorage: config.secondaryTimestampStorage,
    developmentMode: config.developmentMode,
  }).then((context) => {
    context.adminInstructionHandler = createAdminInstructionHandler(context);
    if (config.token) {
      context.expectedAdminToken = config.token;
    }
    return config.listener(context);
  });
