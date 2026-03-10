import { createApiHandler } from './command-api-handler.js';
import { runExpress } from '../runExpress.js';
import { getLogger } from '@lazyapps/logger';

const log = getLogger('EX/CP/HTTP', 'INIT');

const installReadyEndpoints = (context, app) => {
  const readyLog = getLogger('CP/Ready', 'HTTP');

  app.post('/admin/ready', (req, res) => {
    const { correlationId } = req.body || {};
    readyLog.info(
      `CP readiness signal received${correlationId ? ` (${correlationId})` : ''}`,
    );
    if (context.setReady) {
      context.setReady(true);
      readyLog.info('Command processor is now accepting commands');
      res.json({ status: 'ready' });
    } else {
      res.json({ status: 'ready', note: 'readiness not configured' });
    }
  });

  app.get('/admin/ready', (req, res) => {
    const isReady = context.isReady ? context.isReady() : true;
    res.json({ ready: isReady });
  });
};

const installHandlers = (context, app) => {
  const processCommand = createApiHandler(context);
  app.post('/api/command', processCommand);

  // Install ready endpoints when CP readiness is configured
  if (context.setReady) {
    installReadyEndpoints(context, app);
    log.info('Installed CP readiness admin API endpoints');
  }
};

export const express = (externalConfig) =>
  runExpress({ log, installHandlers, ...externalConfig });
