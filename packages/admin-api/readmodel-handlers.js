import { getLogger } from '@lazyapps/logger';
import { nanoid } from 'nanoid';

// --- RM-service handlers (local data, no activator) ---

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

  res.json(
    names.map((name) => {
      const rm = context.readModels[name];
      const base = {
        name,
        endpointName: context.endpointName,
        lastProjectedEventTimestamp: rm.lastProjectedEventTimestamp || 0,
        status: replayStates[name] ? 'replaying' : 'active',
      };
      if (context.lifecycleManager) {
        base.state = context.lifecycleManager.getState(name);
      }
      if (context.projectionHandler.getFifoQueueSize) {
        base.fifoQueueSize = context.projectionHandler.getFifoQueueSize(name);
      }
      return base;
    }),
  );
};

export const replayReadModelStatusHandler = (context) => (req, res) => {
  const { readModelName } = req.params;

  const rm = context.readModels?.[readModelName];
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

// --- Admin-service handlers (proxy through activator) ---

export const adminStatusHandler = (context) => {
  const startedAt = Date.now();
  return (req, res) => {
    const replayStates = context.projectionHandler.getReadModelReplayStates();

    return context.activator
      .fetchReadModels()
      .then((readModels) => {
        res.json({
          service: context.correlationConfig.serviceId,
          uptime: Date.now() - startedAt,
          readModels: readModels.map((rm) => {
            const key = rm.endpointName
              ? `${rm.endpointName}/${rm.name}`
              : rm.name;
            return {
              name: rm.name,
              lastProjectedEventTimestamp: rm.lastProjectedEventTimestamp || 0,
              replaying: !!replayStates[key],
            };
          }),
        });
      })
      .catch(() => {
        res.json({
          service: context.correlationConfig.serviceId,
          uptime: Date.now() - startedAt,
          readModels: [],
        });
      });
  };
};

export const adminReadModelsHandler = (context) => (req, res) =>
  context.activator
    .fetchReadModels()
    .then((readModels) => {
      const replayStates = context.projectionHandler.getReadModelReplayStates();
      res.json(
        readModels.map((rm) => {
          const key = rm.endpointName
            ? `${rm.endpointName}/${rm.name}`
            : rm.name;
          return {
            ...rm,
            status: replayStates[key] ? 'replaying' : rm.status,
          };
        }),
      );
    })
    .catch(() => {
      res.status(503).json({ error: 'Failed to query read model services' });
    });

export const adminReplayReadModelStatusHandler = (context) => (req, res) => {
  const { endpointName, readModelName } = req.params;
  const key = endpointName ? `${endpointName}/${readModelName}` : readModelName;

  const rm = context.activator.getDiscoveredReadModel(key);
  if (!rm) {
    res.status(404).json({ error: `Read model ${readModelName} not found` });
    return;
  }

  const isReplaying = context.projectionHandler.isReadModelReplaying(key);
  const terminalStatus =
    context.projectionHandler.getReadModelTerminalStatus(key);

  res.json({
    readModel: readModelName,
    status: isReplaying ? 'in_progress' : terminalStatus || 'idle',
    lastProjectedEventTimestamp: rm.lastProjectedEventTimestamp || 0,
  });
};

// --- Handlers used by installReadModelAdminApi ---
// These are mounted by installReadModelAdminApi which is used by both admin
// services (with activator) and RM services (with local readModels and
// lifecycleManager). They look up read models from whichever source is
// available.

const resolveReadModel = (context, endpointName, readModelName) => {
  if (context.readModels?.[readModelName]) {
    return context.readModels[readModelName];
  }
  if (context.activator) {
    const key = endpointName
      ? `${endpointName}/${readModelName}`
      : readModelName;
    return context.activator.getDiscoveredReadModel(key) || undefined;
  }
  return undefined;
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
  const { endpointName, readModelName } = req.params;

  const rm = resolveReadModel(context, endpointName, readModelName);
  if (!rm) {
    res.status(404).json({ error: `Read model ${readModelName} not found` });
    return;
  }

  log.info(`Creating backup for ${readModelName}`);

  return delegateToRm(context, correlationId, {
    type: 'create_backup',
    targetReadModel: readModelName,
    ...(rm.endpointName && { targetEndpointName: rm.endpointName }),
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
  const { endpointName, readModelName } = req.params;
  const correlationId = nanoid();
  const log = getLogger('Admin/Backup', correlationId);

  const rm = resolveReadModel(context, endpointName, readModelName);
  if (!rm) {
    res.status(404).json({ error: `Read model ${readModelName} not found` });
    return;
  }

  return delegateToRm(context, correlationId, {
    type: 'list_backups',
    targetReadModel: readModelName,
    ...(rm.endpointName && { targetEndpointName: rm.endpointName }),
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
  const { readModelName, endpointName } = req.query;

  if (!readModelName) {
    res
      .status(400)
      .json({ error: 'readModelName query parameter is required' });
    return;
  }

  log.info(`Deleting backup ${backupId}`);

  const rm = resolveReadModel(context, endpointName, readModelName);
  return delegateToRm(context, correlationId, {
    type: 'delete_backup',
    targetReadModel: readModelName,
    backupId,
    ...(rm?.endpointName && { targetEndpointName: rm.endpointName }),
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
  const { endpointName, readModelName } = req.params;
  const { backupId, fromScratch } = req.body;

  const rm = resolveReadModel(context, endpointName, readModelName);
  if (!rm) {
    res.status(404).json({ error: `Read model ${readModelName} not found` });
    return;
  }

  const stateKey = endpointName
    ? `${endpointName}/${readModelName}`
    : readModelName;

  if (context.projectionHandler.isReadModelReplaying(stateKey)) {
    res.status(409).json({
      error: `Replay already in progress for ${readModelName}`,
    });
    return;
  }

  log.info(`Preparing replay for ${readModelName}`);

  context.projectionHandler.setReadModelReplayState(stateKey, true);

  return delegateToRm(
    context,
    correlationId,
    {
      type: 'prepare_for_replay',
      targetReadModel: readModelName,
      backupId,
      fromScratch,
      ...(rm.endpointName && {
        targetEndpointName: rm.endpointName,
      }),
    },
    60000,
  )
    .then((result) => {
      res.json({
        status: 'prepared',
        readModel: readModelName,
        fromTimestamp: result.fromTimestamp,
        preReplayBackupId: result.preReplayBackupId,
        endpointName: rm.endpointName || context.endpointName,
      });
    })
    .catch((err) => {
      log.error(`Failed to prepare replay: ${err}`);
      context.projectionHandler.clearReadModelReplayState(stateKey);
      res.status(500).json({ error: String(err) });
    });
};

export const resetReplayStateHandler = (context) => (req, res) => {
  const { endpointName, readModelName } = req.params;

  const rm = resolveReadModel(context, endpointName, readModelName);
  if (!rm) {
    res.status(404).json({ error: `Read model ${readModelName} not found` });
    return;
  }

  const stateKey = endpointName
    ? `${endpointName}/${readModelName}`
    : readModelName;
  context.projectionHandler.clearReadModelReplayState(stateKey);
  res.json({ status: 'reset', readModel: readModelName });
};

export const activateReadModelHandler = (context) => (req, res) => {
  const { endpointName, readModelName } = req.params;
  const correlationId = req.body?.correlationId || nanoid();
  const rm = resolveReadModel(context, endpointName, readModelName);
  if (!rm) {
    res.status(404).json({ error: `Read model ${readModelName} not found` });
    return;
  }

  if (context.activator) {
    const identifier = endpointName
      ? `${endpointName}/${readModelName}`
      : readModelName;
    context.activator.activateReadModel(identifier).catch((err) => {
      const log = getLogger('Admin/RM', correlationId);
      log.error(
        `Activation orchestration failed for '${identifier}': ${err.message}`,
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
  if (
    currentState !== 'waiting' &&
    currentState !== 'idle' &&
    currentState !== 'replay-done'
  ) {
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
  const { endpointName, readModelName } = req.params;
  const rm = resolveReadModel(context, endpointName, readModelName);
  if (!rm) {
    res.status(404).json({ error: `Read model ${readModelName} not found` });
    return;
  }

  if (context.activator) {
    const identifier = endpointName
      ? `${endpointName}/${readModelName}`
      : readModelName;
    context.activator.stopReadModel(identifier);
    res.json({ status: 'idle', readModel: readModelName });
    return;
  }

  if (!context.lifecycleManager) {
    res.status(501).json({ error: 'Lifecycle manager not configured' });
    return;
  }

  context.lifecycleManager.stop(readModelName, nanoid());
  res.json({ status: 'idle', readModel: readModelName });
};

export const activateAllHandler = (context) => (req, res) => {
  const correlationId = req.body?.correlationId || nanoid();

  if (context.activator) {
    const discovered = context.activator.getDiscoveredReadModels();
    const allNames = Object.keys(discovered);
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
    return state === 'waiting' || state === 'idle' || state === 'replay-done';
  });

  activated.forEach((name) => {
    context.lifecycleManager.activate(name, correlationId);
  });

  res.status(202).json({ status: 'activating', readModels: activated });
};
