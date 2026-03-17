import {
  statusHandler,
  readModelsHandler,
  replayReadModelStatusHandler,
} from './readmodel-handlers.js';

export { installAdminRoutes } from './routes.js';
export { createSseClient } from './sse-client.js';
export { createOrchestrator } from './orchestration.js';

// PRESERVED: installReadModelStatusApi is used by RM services in the demo
// for activator discovery. statusHandler and readModelsHandler are kept.
export const installReadModelStatusApi = (context) => (app) => {
  app.get('/admin/status', statusHandler(context));
  app.get('/admin/readmodel', readModelsHandler(context));
  app.get(
    '/admin/replay/:endpointName/:readModelName/status',
    replayReadModelStatusHandler(context),
  );
};
