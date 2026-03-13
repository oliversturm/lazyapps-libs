import { getLogger } from '@lazyapps/logger';
import { initializeContext } from './context.js';

const sendReply = (context, replyTopic, correlationId, payload) => {
  if (context.publishAdminReply && replyTopic) {
    context.publishAdminReply(replyTopic, {
      correlationId,
      ...payload,
    });
  }
};

const sendErrorReply = (context, replyTopic, correlationId, err) => {
  sendReply(context, replyTopic, correlationId, { error: String(err) });
};

const handleCreateBackup = (context, correlationId, instruction) => {
  const log = getLogger('RM/Admin', correlationId);
  const { targetReadModel, replyTopic } = instruction;

  if (!context.backup) {
    sendErrorReply(
      context,
      replyTopic,
      correlationId,
      'Backup not configured on this RM service',
    );
    return;
  }

  const rm = context.readModels[targetReadModel];
  const collectionNames = rm.collections || [targetReadModel];

  log.info(`Creating backup for ${targetReadModel}`);
  context.backup
    .createBackup(correlationId, targetReadModel, collectionNames)
    .then((result) => {
      sendReply(context, replyTopic, correlationId, result);
    })
    .catch((err) => {
      log.error(`Failed to create backup: ${err}`);
      sendErrorReply(context, replyTopic, correlationId, err);
    });
};

const handleListBackups = (context, correlationId, instruction) => {
  const log = getLogger('RM/Admin', correlationId);
  const { targetReadModel, replyTopic } = instruction;

  if (!context.backup) {
    sendErrorReply(
      context,
      replyTopic,
      correlationId,
      'Backup not configured on this RM service',
    );
    return;
  }

  log.info(`Listing backups for ${targetReadModel}`);
  context.backup
    .listBackups(targetReadModel)
    .then((backups) => {
      sendReply(context, replyTopic, correlationId, { backups });
    })
    .catch((err) => {
      log.error(`Failed to list backups: ${err}`);
      sendErrorReply(context, replyTopic, correlationId, err);
    });
};

const handleDeleteBackup = (context, correlationId, instruction) => {
  const log = getLogger('RM/Admin', correlationId);
  const { backupId, replyTopic } = instruction;

  if (!context.backup) {
    sendErrorReply(
      context,
      replyTopic,
      correlationId,
      'Backup not configured on this RM service',
    );
    return;
  }

  log.info(`Deleting backup ${backupId}`);
  context.backup
    .deleteBackup(correlationId, backupId)
    .then(() => {
      sendReply(context, replyTopic, correlationId, { deleted: true });
    })
    .catch((err) => {
      log.error(`Failed to delete backup: ${err}`);
      sendErrorReply(context, replyTopic, correlationId, err);
    });
};

const handlePrepareForReplay = (context, correlationId, instruction) => {
  const log = getLogger('RM/Admin', correlationId);
  const { targetReadModel, backupId, fromScratch, replyTopic } = instruction;

  const rm = context.readModels[targetReadModel];
  const collectionNames = rm.collections || [targetReadModel];

  log.info(`Preparing replay for ${targetReadModel}`);

  // Step 1: Create pre-replay safety backup
  (context.backup
    ? context.backup.createBackup(
        correlationId,
        targetReadModel,
        collectionNames,
      )
    : Promise.resolve(null)
  )
    .then((backupResult) => {
      const preReplayBackupId = backupResult ? backupResult.backupId : null;

      context.projectionHandler.setReadModelReplayState(targetReadModel, true);

      // Step 2: Restore backup or clear collections
      const restoreStep = backupId
        ? context.backup.restoreBackup(correlationId, targetReadModel, backupId)
        : fromScratch && context.backup
          ? context.backup.clearCollections(
              correlationId,
              targetReadModel,
              collectionNames,
            )
          : Promise.resolve();

      return restoreStep
        .then(() => {
          // Step 3: Determine fromTimestamp
          if (backupId) {
            return context.backup
              .listBackups(targetReadModel)
              .then((backups) => {
                const restored = backups.find((b) => b.backupId === backupId);
                return restored ? restored.eventTimestamp : 0;
              });
          }
          if (fromScratch) return Promise.resolve(0);
          return Promise.resolve(rm.lastProjectedEventTimestamp || 0);
        })
        .then((fromTimestamp) =>
          // Step 4: Mark replayInProgress in readmodel.state
          context.storage
            .perRequest(correlationId)
            .updateOne(
              'readmodel.state',
              { name: targetReadModel },
              {
                $set: {
                  replayInProgress: true,
                  preReplayBackupId,
                },
              },
            )
            .then(() => {
              sendReply(context, replyTopic, correlationId, {
                fromTimestamp,
                preReplayBackupId,
              });
            }),
        );
    })
    .catch((err) => {
      log.error(`Failed to prepare replay: ${err}`);
      context.projectionHandler.clearReadModelReplayState(targetReadModel);
      sendErrorReply(context, replyTopic, correlationId, err);
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

      case 'restart':
        if (!lm) {
          log.warn('Restart requires lifecycle manager');
          return;
        }
        if (!targetReadModel) {
          log.warn('Restart instruction missing targetReadModel');
          return;
        }
        lm.stop(targetReadModel, correlationId);
        lm.activate(targetReadModel, correlationId).catch((err) => {
          log.error(`Failed to restart '${targetReadModel}': ${err.message}`);
        });
        break;

      case 'create_backup':
        handleCreateBackup(context, correlationId, instruction);
        break;

      case 'list_backups':
        handleListBackups(context, correlationId, instruction);
        break;

      case 'delete_backup':
        handleDeleteBackup(context, correlationId, instruction);
        break;

      case 'prepare_for_replay':
        handlePrepareForReplay(context, correlationId, instruction);
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
