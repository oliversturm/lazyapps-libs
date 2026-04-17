import { getLogger, safeStringify } from '@lazyapps/logger';

export const adminHandler = (context) => (req, res) => {
  const { correlationId } = req.body;
  const log = getLogger('EX/CP/AdHandler', correlationId);

  const { command } = req.params;
  const handler = context.handleAdminCommand;
  if (!handler) {
    log.error(`Invalid admin command ${command}`);
    res.status(400).send('Invalid admin command');
    return;
  }

  log.debug(
    `Admin command ${command} with params ${safeStringify(req.body.params)}`,
  );
  return handler(
    context,
    command,
    req.body.params,
    req.auth,
    req.body.correlationId,
  )
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
