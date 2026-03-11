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

  log.info(`Starting replay for ${readModel} from ${fromTimestamp || 0}`);

  context.eventBus.publishAdminInstruction(correlationId)({
    type: 'start_replay',
    readModel,
    fromTimestamp: fromTimestamp || 0,
    toTimestamp: toTimestamp || null,
    targetServiceId,
    correlationId,
  });

  res.json({ status: 'started', readModel, correlationId });
};

export const replayStatusHandler = (context) => (req, res) => {
  const { readModel } = req.params;
  const replayStates = context.projectionHandler.getReadModelReplayStates();
  res.json({
    readModel,
    status: replayStates[readModel] ? 'in_progress' : 'idle',
  });
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

  context.eventBus.publishAdminInstruction(correlationId)({
    type: 'cancel_replay',
    readModel,
    correlationId,
  });

  res.json({ status: 'cancelling', readModel });
};
