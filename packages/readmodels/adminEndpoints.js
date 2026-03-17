import { getLogger } from '@lazyapps/logger';

const tokenAuth = (expectedToken) => (req, res, next) => {
  if (!expectedToken) return next();
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid authorization' });
    return;
  }
  const token = authHeader.slice(7);
  if (token !== expectedToken) {
    res.status(403).json({ error: 'Invalid token' });
    return;
  }
  next();
};

export const installAdminEndpoints = (context, app) => {
  const log = getLogger('RM/AdminEP', 'INIT');
  const auth = tokenAuth(context.expectedAdminToken);

  // GET /admin/events/:ep — SSE stream for all RMs on this service
  app.get('/admin/events/:ep', auth, (req, res) => {
    const ep = req.params.ep;
    if (context.endpointName && ep !== context.endpointName) {
      res.status(404).json({ error: 'Unknown endpoint' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(':keepalive\n\n');

    context.statusTracker.addSseClient(res);

    req.on('close', () => {
      context.statusTracker.removeSseClient(res);
    });
  });

  // GET /admin/status/:ep/:rm — status info block for a specific RM
  app.get('/admin/status/:ep/:rm', auth, (req, res) => {
    const { ep, rm } = req.params;
    if (context.endpointName && ep !== context.endpointName) {
      res.status(404).json({ error: 'Unknown endpoint' });
      return;
    }
    const status = context.statusTracker.getStatus(rm);
    if (!status) {
      res.status(404).json({ error: `Read model '${rm}' not found` });
      return;
    }
    res.json(status);
  });

  // GET /admin/replayRelevantEvents/:ep/:rm — event types for replay
  app.get('/admin/replayRelevantEvents/:ep/:rm', auth, (req, res) => {
    const { ep, rm } = req.params;
    if (context.endpointName && ep !== context.endpointName) {
      res.status(404).json({ error: 'Unknown endpoint' });
      return;
    }
    const readModel = context.readModels[rm];
    if (!readModel) {
      res.status(404).json({ error: `Read model '${rm}' not found` });
      return;
    }
    const events = readModel.replayRelevantEvents || null;
    if (!events) {
      res
        .status(400)
        .json({ error: `Read model '${rm}' has no replayRelevantEvents` });
      return;
    }
    res.json(events);
  });

  log.info('Admin endpoints installed');
};
