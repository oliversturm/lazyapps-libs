import { createApiHandler } from './command-api-handler.js';
import { runExpress } from '../runExpress.js';
import { getLogger } from '@lazyapps/logger';

const log = getLogger('EX/CP/HTTP', 'INIT');

const installAdminEndpoints = (context, app) => {
  const adminLog = getLogger('CP/Admin', 'HTTP');
  const { statusTracker } = context;

  const tokenAuth = (req, res, next) => {
    const token = context.adminToken;
    if (!token) return next();
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${token}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  };

  app.get('/admin/commandprocessor/status', tokenAuth, (req, res) => {
    res.json(statusTracker.getStatus());
  });

  app.get('/admin/commandprocessor/events', tokenAuth, (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('\n');

    // Send current status immediately
    const status = statusTracker.getStatus();
    res.write(`event: status-change\ndata: ${JSON.stringify(status)}\n\n`);

    statusTracker.addSseClient(res);
    adminLog.info('SSE client connected to CP events');

    req.on('close', () => {
      statusTracker.removeSseClient(res);
      adminLog.info('SSE client disconnected from CP events');
    });
  });
};

const installHandlers = (context, app) => {
  const processCommand = createApiHandler(context);
  app.post('/api/command', processCommand);

  // Install admin status/SSE endpoints when statusTracker is available
  if (context.statusTracker) {
    installAdminEndpoints(context, app);
    log.info('Installed CP admin status and SSE endpoints');
  }
};

export const express = (externalConfig) =>
  runExpress({ log, installHandlers, ...externalConfig });
