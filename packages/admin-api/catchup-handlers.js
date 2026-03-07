import { getLogger } from '@lazyapps/logger';
import { nanoid } from 'nanoid';

export const startCatchupHandler = (context) => (req, res) => {
  const { readModelName } = req.params;
  const { fromTimestamp, serviceId } = req.body;
  const correlationId = nanoid();
  const log = getLogger('Admin/CatchUp', correlationId);

  log.info(`Starting catch-up for ${readModelName} from ${fromTimestamp || 0}`);

  context.catchupHandler
    .startCatchup(correlationId, readModelName, fromTimestamp || 0)
    .catch((err) => {
      log.error(`Catch-up failed for ${readModelName}: ${err}`);
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

  return context.catchupHandler
    .cancelCatchup(correlationId, readModelName)
    .then(() => {
      res.json({ status: 'cancelling', readModel: readModelName });
    })
    .catch((err) => {
      log.error(`Failed to cancel catch-up: ${err}`);
      res.status(500).json({ error: String(err) });
    });
};

export const getCatchupStatusHandler = (context) => (req, res) => {
  const { readModelName } = req.params;
  res.json(context.catchupHandler.getCatchupStatus(readModelName));
};
