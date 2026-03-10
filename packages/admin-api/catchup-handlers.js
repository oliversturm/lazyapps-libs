import { getLogger } from '@lazyapps/logger';
import { nanoid } from 'nanoid';

export const startCatchupHandler = (context) => (req, res) => {
  const { readModelName } = req.params;
  const { fromTimestamp, serviceId } = req.body;
  const correlationId = nanoid();
  const log = getLogger('Admin/CatchUp', correlationId);

  log.info(`Starting catch-up for ${readModelName} from ${fromTimestamp || 0}`);

  context.eventBus.publishAdminInstruction(correlationId)({
    type: 'start_catchup',
    readModel: readModelName,
    fromTimestamp: fromTimestamp || 0,
    serviceId,
    correlationId,
  });

  res.json({
    status: 'started',
    readModel: readModelName,
    correlationId,
  });
};

export const cancelCatchupHandler = (context) => (req, res) => {
  const { readModelName } = req.params;
  const correlationId = nanoid();
  const log = getLogger('Admin/CatchUp', correlationId);

  log.info(`Cancelling catch-up for ${readModelName}`);

  context.eventBus.publishAdminInstruction(correlationId)({
    type: 'cancel_catchup',
    readModel: readModelName,
    correlationId,
  });

  res.json({ status: 'cancelling', readModel: readModelName });
};

export const getCatchupStatusHandler = (context) => (req, res) => {
  const { readModelName } = req.params;
  // Catch-up status is tracked on the CP side; the admin service
  // monitors __system messages for CATCHUP_EVENTS_DONE / CATCHUP_CANCELLED.
  // Return what we know from the projection handler.
  const replayStates = context.projectionHandler.getReadModelReplayStates();
  res.json({
    readModel: readModelName,
    status: replayStates[readModelName] ? 'in_progress' : 'idle',
  });
};
