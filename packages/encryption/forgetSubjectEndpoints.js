import { getLogger } from '@lazyapps/logger';

export const createForgetSubjectEndpoints = (encryption) => (context, app) => {
  const log = getLogger('Encryption/Endpoints', 'INIT');

  app.post('/api/forget-subject', (req, res) => {
    const reqTimestamp = Date.now();
    const correlationId = req.body.correlationId;
    const reqLog = getLogger('Encryption/ForgetSubject', correlationId);

    const subjectId = req.body.subjectId;
    if (!subjectId) {
      res.status(400).json({ error: 'Missing subjectId' });
      return;
    }

    const aggregate = context.aggregates && context.aggregates.subjectLifecycle;
    if (!aggregate) {
      reqLog.error('subjectLifecycle aggregate not registered');
      res.status(500).json({ error: 'subjectLifecycle aggregate not found' });
      return;
    }

    const commandHandler =
      aggregate.commands && aggregate.commands.FORGET_SUBJECT;
    if (!commandHandler) {
      reqLog.error('FORGET_SUBJECT command not found on subjectLifecycle');
      res.status(500).json({ error: 'FORGET_SUBJECT command not found' });
      return;
    }

    const payload = {
      subjectId,
      subjectType: req.body.subjectType || 'unknown',
      reason: req.body.reason || 'Right to be forgotten',
      requestedBy:
        req.body.requestedBy || (req.auth && req.auth.sub) || 'system',
    };

    context
      .handleCommand(
        context.aggregateStore,
        context.eventStore,
        context.eventBus,
        'FORGET_SUBJECT',
        'subjectLifecycle',
        subjectId,
        payload,
        commandHandler,
        req.auth,
        reqTimestamp,
        correlationId,
      )
      .then(() => {
        res.json({ status: 'forgotten', subjectId });
      })
      .catch((err) => {
        if (err.name === 'ValidationError') {
          reqLog.error(`Validation error: ${err.message}`);
          res.status(400).json({ error: err.message });
        } else {
          reqLog.error(`Error forgetting subject ${subjectId}: ${err}`);
          res.status(500).json({ error: err.message });
        }
      });
  });

  app.post('/api/admin/rotate-context-key', (req, res) => {
    const correlationId = req.body.correlationId;
    const reqLog = getLogger('Encryption/RotateKey', correlationId);

    const contextName = req.body.contextName;
    if (!contextName) {
      res.status(400).json({ error: 'Missing contextName' });
      return;
    }

    encryption
      .then((enc) => enc.rotateContextKey(contextName))
      .then(() => {
        res.json({ status: 'rotated', context: contextName });
      })
      .catch((err) => {
        reqLog.error(`Error rotating key for context ${contextName}: ${err}`);
        res.status(500).json({ error: err.message });
      });
  });

  log.info('Forget-subject and rotate-context-key endpoints installed');
};
