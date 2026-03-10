import { getLogger } from '@lazyapps/logger';
import { nanoid } from 'nanoid';

const detectSharedCollections = (readModels, targetName, targetCollections) => {
  const warnings = [];
  const targetSet = new Set(targetCollections);

  Object.keys(readModels).forEach((rmName) => {
    if (rmName === targetName) return;
    const rm = readModels[rmName];
    const rmCollections = rm.collections || [rmName];
    const shared = rmCollections.filter((c) => targetSet.has(c));
    if (shared.length) {
      warnings.push(
        `Read model '${rmName}' shares collections: ${shared.join(', ')}`,
      );
    }
  });

  return warnings;
};

export const statusHandler = (context) => {
  const startedAt = Date.now();
  return (req, res) => {
    const replayStates = context.projectionHandler.getReadModelReplayStates();

    res.json({
      service: context.correlationConfig.serviceId,
      uptime: Date.now() - startedAt,
      readModels: Object.keys(context.readModels).map((name) => ({
        name,
        lastProjectedEventTimestamp:
          context.readModels[name].lastProjectedEventTimestamp || 0,
        replaying: !!replayStates[name],
      })),
    });
  };
};

export const readModelsHandler = (context) => (req, res) => {
  const replayStates = context.projectionHandler.getReadModelReplayStates();
  const names = Object.keys(context.readModels);

  const buildLocal = () =>
    names.map((name) => {
      const rm = context.readModels[name];
      const base = {
        name,
        lastProjectedEventTimestamp: rm.lastProjectedEventTimestamp || 0,
        status: replayStates[name] ? 'replaying' : 'active',
        collections: rm.collections || [name],
      };
      if (context.lifecycleManager) {
        base.state = context.lifecycleManager.getState(name);
      }
      if (context.projectionHandler.getFifoQueueSize) {
        base.fifoQueueSize = context.projectionHandler.getFifoQueueSize(name);
      }
      return base;
    });

  // When the admin context has an activator but no lifecycle manager
  // (i.e., admin service running separately or in monolith without
  // sharedState), proxy state from the RM HTTP endpoints.
  if (context.activator && !context.lifecycleManager) {
    Promise.all(
      names.map((name) =>
        context.activator.queryReadModelState(name).catch(() => null),
      ),
    )
      .then((rmStates) => {
        const local = buildLocal();
        local.forEach((entry, i) => {
          const remote = rmStates[i];
          if (remote) {
            entry.state = remote.state;
            entry.lastProjectedEventTimestamp =
              remote.lastProjectedEventTimestamp ||
              entry.lastProjectedEventTimestamp;
            if (remote.fifoQueueSize !== undefined) {
              entry.fifoQueueSize = remote.fifoQueueSize;
            }
          }
        });
        res.json(local);
      })
      .catch(() => {
        res.json(buildLocal());
      });
    return;
  }

  res.json(buildLocal());
};

export const createBackupHandler = (context) => (req, res) => {
  const correlationId = req.body.correlationId || nanoid();
  const log = getLogger('Admin/Backup', correlationId);
  const { readModelName } = req.params;

  const rm = context.readModels[readModelName];
  if (!rm) {
    res.status(404).json({ error: `Read model ${readModelName} not found` });
    return;
  }

  if (!context.backup) {
    res.status(501).json({ error: 'Backup not configured' });
    return;
  }

  const collectionNames = rm.collections || [readModelName];
  log.info(`Creating backup for ${readModelName}`);

  return context.backup
    .createBackup(correlationId, readModelName, collectionNames)
    .then((result) => {
      res.json(result);
    })
    .catch((err) => {
      log.error(`Failed to create backup: ${err}`);
      res.status(500).json({ error: String(err) });
    });
};

export const listBackupsHandler = (context) => (req, res) => {
  const { readModelName } = req.params;

  const rm = context.readModels[readModelName];
  if (!rm) {
    res.status(404).json({ error: `Read model ${readModelName} not found` });
    return;
  }

  if (!context.backup) {
    res.status(501).json({ error: 'Backup not configured' });
    return;
  }

  return context.backup
    .listBackups(readModelName)
    .then((backups) => {
      res.json(backups);
    })
    .catch((err) => {
      const log = getLogger('Admin/Backup', nanoid());
      log.error(`Failed to list backups for ${readModelName}: ${err}`);
      res.status(500).json({ error: String(err) });
    });
};

export const deleteBackupHandler = (context) => (req, res) => {
  const correlationId = nanoid();
  const log = getLogger('Admin/Backup', correlationId);
  const { backupId } = req.params;

  if (!context.backup) {
    res.status(501).json({ error: 'Backup not configured' });
    return;
  }

  log.info(`Deleting backup ${backupId}`);

  return context.backup
    .deleteBackup(correlationId, backupId)
    .then(() => {
      res.sendStatus(204);
    })
    .catch((err) => {
      log.error(`Failed to delete backup: ${err}`);
      res.status(500).json({ error: String(err) });
    });
};

export const prepareReplayHandler = (context) => (req, res) => {
  const correlationId = req.body.correlationId || nanoid();
  const log = getLogger('Admin/Prepare', correlationId);
  const { readModelName } = req.params;
  const { backupId, fromScratch } = req.body;

  const rm = context.readModels[readModelName];
  if (!rm) {
    res.status(404).json({ error: `Read model ${readModelName} not found` });
    return;
  }

  if (context.projectionHandler.isReadModelReplaying(readModelName)) {
    res.status(409).json({
      error: `Replay already in progress for ${readModelName}`,
    });
    return;
  }

  if ((backupId || fromScratch) && !context.backup) {
    res.status(501).json({
      error: 'Backup module required for restore or from-scratch replay',
    });
    return;
  }

  const collectionNames = rm.collections || [readModelName];
  const warnings = detectSharedCollections(
    context.readModels,
    readModelName,
    collectionNames,
  );

  log.info(`Preparing replay for ${readModelName}`);

  // Step 1: Create pre-replay safety backup
  return (
    context.backup
      ? context.backup.createBackup(
          correlationId,
          readModelName,
          collectionNames,
        )
      : Promise.resolve(null)
  )
    .then((backupResult) => {
      const preReplayBackupId = backupResult ? backupResult.backupId : null;

      // Step 2: Set per-read-model replay state
      context.projectionHandler.setReadModelReplayState(readModelName, true);

      // Step 3: Restore backup or clear collections
      const restoreStep = backupId
        ? context.backup.restoreBackup(correlationId, readModelName, backupId)
        : fromScratch
          ? context.backup.clearCollections(
              correlationId,
              readModelName,
              collectionNames,
            )
          : Promise.resolve();

      return restoreStep
        .then(() => {
          // Step 4: Determine fromTimestamp
          if (backupId) {
            return context.backup.listBackups(readModelName).then((backups) => {
              const restored = backups.find((b) => b.backupId === backupId);
              return restored ? restored.eventTimestamp : 0;
            });
          }
          if (fromScratch) return Promise.resolve(0);
          return Promise.resolve(rm.lastProjectedEventTimestamp || 0);
        })
        .then((fromTimestamp) =>
          // Step 5: Mark replayInProgress in readmodel.state
          context.storage
            .perRequest(correlationId)
            .updateOne(
              'readmodel.state',
              { name: readModelName },
              {
                $set: {
                  replayInProgress: true,
                  preReplayBackupId,
                },
              },
            )
            .then(() => {
              res.json({
                status: 'prepared',
                readModel: readModelName,
                fromTimestamp,
                preReplayBackupId,
                warnings,
                serviceId: context.correlationConfig.serviceId,
              });
            }),
        );
    })
    .catch((err) => {
      log.error(`Failed to prepare replay: ${err}`);
      context.projectionHandler.clearReadModelReplayState(readModelName);
      res.status(500).json({ error: String(err) });
    });
};

export const replayReadModelStatusHandler = (context) => (req, res) => {
  const { readModelName } = req.params;

  const rm = context.readModels[readModelName];
  if (!rm) {
    res.status(404).json({ error: `Read model ${readModelName} not found` });
    return;
  }

  const isReplaying =
    context.projectionHandler.isReadModelReplaying(readModelName);

  res.json({
    readModel: readModelName,
    status: isReplaying ? 'in_progress' : 'idle',
    lastProjectedEventTimestamp: rm.lastProjectedEventTimestamp || 0,
  });
};

export const resetReplayStateHandler = (context) => (req, res) => {
  const { readModelName } = req.params;

  const rm = context.readModels[readModelName];
  if (!rm) {
    res.status(404).json({ error: `Read model ${readModelName} not found` });
    return;
  }

  context.projectionHandler.clearReadModelReplayState(readModelName);
  res.json({ status: 'reset', readModel: readModelName });
};

export const activateReadModelHandler = (context) => (req, res) => {
  const { readModelName } = req.params;
  const correlationId = req.body?.correlationId || nanoid();
  const rm = context.readModels[readModelName];
  if (!rm) {
    res.status(404).json({ error: `Read model ${readModelName} not found` });
    return;
  }

  if (context.activator) {
    // Use the admin service's orchestration: message bus → query RM → CP catchup
    context.activator.activateReadModel(readModelName).catch((err) => {
      const log = getLogger('Admin/RM', correlationId);
      log.error(
        `Activation orchestration failed for '${readModelName}': ${err.message}`,
      );
    });
    res.status(202).json({ status: 'activating', readModel: readModelName });
    return;
  }

  if (!context.lifecycleManager) {
    res.status(501).json({ error: 'Lifecycle manager not configured' });
    return;
  }

  const currentState = context.lifecycleManager.getState(readModelName);
  if (currentState !== 'waiting' && currentState !== 'stopped') {
    res.status(409).json({
      error:
        `Read model ${readModelName} is in state '${currentState}', ` +
        `cannot activate`,
    });
    return;
  }

  context.lifecycleManager
    .activate(readModelName, correlationId)
    .catch(() => {});
  res.status(202).json({ status: 'activating', readModel: readModelName });
};

export const stopReadModelHandler = (context) => (req, res) => {
  const { readModelName } = req.params;
  const correlationId = req.body?.correlationId || nanoid();
  const rm = context.readModels[readModelName];
  if (!rm) {
    res.status(404).json({ error: `Read model ${readModelName} not found` });
    return;
  }

  if (context.activator) {
    context.activator.stopReadModel(readModelName);
    res.json({ status: 'stopped', readModel: readModelName });
    return;
  }

  if (!context.lifecycleManager) {
    res.status(501).json({ error: 'Lifecycle manager not configured' });
    return;
  }

  context.lifecycleManager.stop(readModelName, correlationId);
  res.json({ status: 'stopped', readModel: readModelName });
};

export const activateAllHandler = (context) => (req, res) => {
  const correlationId = req.body?.correlationId || nanoid();

  if (context.activator) {
    const allNames = Object.keys(context.readModels);
    allNames.forEach((name) => {
      context.activator.activateReadModel(name).catch((err) => {
        const log = getLogger('Admin/RM', correlationId);
        log.error(
          `Activation orchestration failed for '${name}': ${err.message}`,
        );
      });
    });
    res.status(202).json({ status: 'activating', readModels: allNames });
    return;
  }

  if (!context.lifecycleManager) {
    res.status(501).json({ error: 'Lifecycle manager not configured' });
    return;
  }

  const activated = Object.keys(context.readModels).filter((name) => {
    const state = context.lifecycleManager.getState(name);
    return state === 'waiting' || state === 'stopped';
  });

  activated.forEach((name) => {
    context.lifecycleManager.activate(name, correlationId);
  });

  res.status(202).json({ status: 'activating', readModels: activated });
};

export const __testing__ = { detectSharedCollections };
