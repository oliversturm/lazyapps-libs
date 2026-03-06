import { getLogger } from '@lazyapps/logger';
import { nanoid } from 'nanoid';

export const startReplayHandler = (context) => (req, res) => {
  const correlationId = req.body.correlationId || nanoid();
  const log = getLogger('Admin/Replay', correlationId);
  const { readModel, fromTimestamp, toTimestamp, targetServiceId } = req.body;

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
      targetServiceId,
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

export const setCommandReplayStateHandler = (context) => (req, res) => {
  const correlationId = nanoid();
  const log = getLogger('Admin/CommandReplayState', correlationId);
  const { state } = req.body;

  if (typeof state !== 'boolean') {
    res.status(400).json({ error: 'state (boolean) is required' });
    return;
  }

  log.info(`Setting command replay state to ${state}`);

  return Promise.resolve()
    .then(() => context.eventBus.publishReplayState(correlationId)(state))
    .then(() => {
      res.json({ status: 'ok', commandReplayState: state });
    })
    .catch((err) => {
      log.error(`Failed to set command replay state: ${err}`);
      res.status(500).json({ error: String(err) });
    });
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
