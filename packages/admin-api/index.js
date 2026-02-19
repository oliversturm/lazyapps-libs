import {
  startReplayHandler,
  replayStatusHandler,
  cancelReplayHandler,
  legacyAdminHandler,
} from './replay-handlers.js';

import {
  statusHandler,
  readModelsHandler,
  createBackupHandler,
  listBackupsHandler,
  deleteBackupHandler,
  prepareReplayHandler,
  replayReadModelStatusHandler,
} from './readmodel-handlers.js';

export const installReplayAdminApi = (context) => (app) => {
  app.post('/api/admin/startReplay', startReplayHandler(context));
  app.get('/api/admin/replayStatus/:readModel', replayStatusHandler(context));
  app.post('/api/admin/cancelReplay', cancelReplayHandler(context));

  // Legacy backward compat for command-replay CLI tool
  app.post('/api/admin/:command', legacyAdminHandler(context));
};

export const installReadModelAdminApi = (context) => (app) => {
  app.get('/admin/status', statusHandler(context));
  app.get('/admin/readmodels', readModelsHandler(context));

  app.post('/admin/backup/:readModelName', createBackupHandler(context));
  app.get('/admin/backups/:readModelName', listBackupsHandler(context));
  app.delete('/admin/backup/:backupId', deleteBackupHandler(context));

  app.post(
    '/admin/replay/:readModelName/prepare',
    prepareReplayHandler(context),
  );
  app.get(
    '/admin/replay/:readModelName/status',
    replayReadModelStatusHandler(context),
  );
};
