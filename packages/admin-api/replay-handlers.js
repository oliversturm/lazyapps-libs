import { getLogger } from '@lazyapps/logger';
import { nanoid } from 'nanoid';

export const startReplayHandler = (context) => (req, res) => {
  const correlationId = req.body.correlationId || nanoid();
  const log = getLogger('Admin/Replay', correlationId);
  const { readModel, fromTimestamp, toTimestamp } = req.body;

  if (!readModel) {
    res.status(400).json({ error: 'readModel is required' });
    return;
  }

  const currentStatus = context.replayHandler.getReplayStatus(readModel);
  if (currentStatus.status === 'in_progress') {
    res
      .status(409)
      .json({ error: `Replay already in progress for ${readModel}` });
    return;
  }

  log.info(`Starting replay for ${readModel} from ${fromTimestamp || 0}`);

  // Start replay in background (streaming runs asynchronously)
  context.replayHandler
    .startReplay(
      correlationId,
      readModel,
      fromTimestamp || 0,
      toTimestamp || null,
    )
    .catch((err) => {
      log.error(`Replay failed for ${readModel}: ${err}`);
    });

  res.json({ status: 'started', readModel });
};

export const replayStatusHandler = (context) => (req, res) => {
  const { readModel } = req.params;
  res.json(context.replayHandler.getReplayStatus(readModel));
};

export const cancelReplayHandler = (context) => (req, res) => {
  const correlationId = req.body.correlationId || nanoid();
  const log = getLogger('Admin/Replay', correlationId);
  const { readModel } = req.body;

  if (!readModel) {
    res.status(400).json({ error: 'readModel is required' });
    return;
  }

  log.info(`Cancelling replay for ${readModel}`);

  return context.replayHandler
    .cancelReplay(correlationId, readModel)
    .then(() => {
      res.json({ status: 'cancelling', readModel });
    })
    .catch((err) => {
      log.error(`Failed to cancel replay: ${err}`);
      res.status(500).json({ error: String(err) });
    });
};

export const legacyAdminHandler = (context) => (req, res) => {
  const { correlationId } = req.body;
  const log = getLogger('Admin/Legacy', correlationId);
  const { command } = req.params;

  const handler = context.handleAdminCommand;
  if (!handler) {
    log.error(`No admin command handler available`);
    res.sendStatus(400);
    return;
  }

  log.debug(
    `Legacy admin command ${command} with params ${JSON.stringify(req.body.params)}`,
  );

  return handler(context, command, req.body.params, req.auth, correlationId)
    .then(() => {
      res.sendStatus(200);
    })
    .catch((err) => {
      log.error(`Error: ${err}`);
      if (err.name === 'ValidationError') {
        res.sendStatus(400);
      } else if (err.name === 'AuthorizationError') {
        res.sendStatus(403);
      } else {
        res.sendStatus(500);
      }
    });
};
