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

const delegateToRm = (context, correlationId, instruction, timeoutMs) => {
  const replyTopic = `__admin_reply/${nanoid()}`;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(
          `Timed out waiting for ${instruction.type} reply for '${instruction.targetReadModel}'`,
        ),
      );
    }, timeoutMs || 30000);

    context.eventBus
      .subscribeAdminReply(replyTopic, (payload) => {
        clearTimeout(timeout);
        if (payload.error) {
          reject(new Error(payload.error));
        } else {
          resolve(payload);
        }
      })
      .then(() => {
        context.eventBus.publishAdminInstruction(correlationId)({
          ...instruction,
          replyTopic,
          correlationId,
        });
      });
  });
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

  log.info(`Creating backup for ${readModelName}`);

  return delegateToRm(context, correlationId, {
    type: 'create_backup',
    targetReadModel: readModelName,
  })
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
  const correlationId = nanoid();
  const log = getLogger('Admin/Backup', correlationId);

  const rm = context.readModels[readModelName];
  if (!rm) {
    res.status(404).json({ error: `Read model ${readModelName} not found` });
    return;
  }

  return delegateToRm(context, correlationId, {
    type: 'list_backups',
    targetReadModel: readModelName,
  })
    .then((result) => {
      res.json(result.backups);
    })
    .catch((err) => {
      log.error(`Failed to list backups for ${readModelName}: ${err}`);
      res.status(500).json({ error: String(err) });
    });
};

export const deleteBackupHandler = (context) => (req, res) => {
  const correlationId = nanoid();
  const log = getLogger('Admin/Backup', correlationId);
  const { backupId } = req.params;
  const { readModelName } = req.query;

  if (!readModelName) {
    res
      .status(400)
      .json({ error: 'readModelName query parameter is required' });
    return;
  }

  log.info(`Deleting backup ${backupId}`);

  return delegateToRm(context, correlationId, {
    type: 'delete_backup',
    targetReadModel: readModelName,
    backupId,
  })
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

  const collectionNames = rm.collections || [readModelName];
  const warnings = detectSharedCollections(
    context.readModels,
    readModelName,
    collectionNames,
  );

  log.info(`Preparing replay for ${readModelName}`);

  context.projectionHandler.setReadModelReplayState(readModelName, true);

  return delegateToRm(
    context,
    correlationId,
    {
      type: 'prepare_for_replay',
      targetReadModel: readModelName,
      backupId,
      fromScratch,
    },
    60000,
  )
    .then((result) => {
      res.json({
        status: 'prepared',
        readModel: readModelName,
        fromTimestamp: result.fromTimestamp,
        preReplayBackupId: result.preReplayBackupId,
        warnings,
        serviceId: context.correlationConfig.serviceId,
      });
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
  const terminalStatus =
    context.projectionHandler.getReadModelTerminalStatus(readModelName);

  res.json({
    readModel: readModelName,
    status: isReplaying ? 'in_progress' : terminalStatus || 'idle',
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
