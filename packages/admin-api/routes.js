import { getLogger } from '@lazyapps/logger';
import { nanoid } from 'nanoid';

const createRoutes = ({ sseClient, orchestrator, eventBus, token }) => {
  const publishCommand = (correlationId, command) => {
    eventBus.publishAdminInstruction(correlationId)({
      ...command,
      correlationId,
      ...(token && { token }),
    });
  };

  const validateReadModel = (req, res) => {
    const { ep, rm } = req.params;
    const status = sseClient.cache.getReadModel(ep, rm);
    if (!status) {
      res.status(404).json({ error: `Read model ${ep}/${rm} not found` });
      return false;
    }
    return true;
  };

  // --- Status endpoints (serve from cache) ---

  const readModelStatusAll = (req, res) => {
    const allRms = sseClient.cache.getAllReadModels();
    res.json(Object.values(allRms));
  };

  const readModelStatusOne = (req, res) => {
    const { ep, rm } = req.params;
    const status = sseClient.cache.getReadModel(ep, rm);
    if (!status) {
      res.status(404).json({ error: `Read model ${ep}/${rm} not found` });
      return;
    }
    res.json(status);
  };

  const commandProcessorStatus = (req, res) => {
    res.json(sseClient.cache.getCommandProcessor());
  };

  // --- SSE stream to browser ---

  const sseStream = (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(':keepalive\n\n');

    // Send current cache state as initial data
    const allRms = sseClient.cache.getAllReadModels();
    Object.values(allRms).forEach((rm) => {
      res.write(`event: readmodel-status\ndata: ${JSON.stringify(rm)}\n\n`);
    });
    const cp = sseClient.cache.getCommandProcessor();
    res.write(
      `event: commandprocessor-status\ndata: ${JSON.stringify(cp)}\n\n`,
    );

    const onRmStatus = (data) => {
      res.write(`event: readmodel-status\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const onCpStatus = (data) => {
      res.write(
        `event: commandprocessor-status\ndata: ${JSON.stringify(data)}\n\n`,
      );
    };

    sseClient.addBrowserClient();
    sseClient.emitter.on('readmodel-status', onRmStatus);
    sseClient.emitter.on('commandprocessor-status', onCpStatus);

    req.on('close', () => {
      sseClient.emitter.off('readmodel-status', onRmStatus);
      sseClient.emitter.off('commandprocessor-status', onCpStatus);
      sseClient.removeBrowserClient();
    });
  };

  // --- Replay endpoints ---

  const startReplay = (req, res) => {
    const { ep, rm } = req.params;
    const { backupId, autoBackup, activateAfter } = req.body || {};
    const correlationId = nanoid();
    const log = getLogger('Admin/Replay', correlationId);

    log.info(`Replay requested for ${ep}/${rm}`);

    // Fire off orchestration — don't await, return immediately
    orchestrator
      .replayOrchestration(ep, rm, { backupId, autoBackup, activateAfter })
      .catch((err) => {
        log.error(
          `Replay orchestration failed for ${ep}/${rm}: ${err.message}`,
        );
      });

    res.status(202).json({
      status: 'started',
      endpointName: ep,
      readModel: rm,
      correlationId,
    });
  };

  const cancelReplay = (req, res) => {
    const { ep, rm } = req.params;
    const { reset } = req.body || {};

    return orchestrator
      .cancelReplayOrchestration(ep, rm, { reset })
      .then((result) => {
        res.json(result);
      });
  };

  // --- Backup endpoints ---

  const createBackup = (req, res) => {
    if (!validateReadModel(req, res)) return;
    const { ep, rm } = req.params;
    const correlationId = nanoid();

    publishCommand(correlationId, {
      type: 'createBackup',
      targetEndpointName: ep,
      targetReadModel: rm,
    });

    res.status(202).json({
      status: 'creating',
      endpointName: ep,
      readModel: rm,
      correlationId,
    });
  };

  const cancelBackup = (req, res) => {
    if (!validateReadModel(req, res)) return;
    const { ep, rm } = req.params;
    const correlationId = nanoid();

    publishCommand(correlationId, {
      type: 'cancelBackup',
      targetEndpointName: ep,
      targetReadModel: rm,
    });

    res.json({ status: 'cancelling', correlationId });
  };

  const restoreBackup = (req, res) => {
    if (!validateReadModel(req, res)) return;
    const { ep, rm } = req.params;
    const { backupId } = req.body || {};
    const correlationId = nanoid();

    if (!backupId) {
      res.status(400).json({ error: 'backupId is required' });
      return;
    }

    publishCommand(correlationId, {
      type: 'restoreBackup',
      targetEndpointName: ep,
      targetReadModel: rm,
      backupId,
    });

    res.status(202).json({ status: 'restoring', correlationId });
  };

  const deleteBackup = (req, res) => {
    if (!validateReadModel(req, res)) return;
    const { ep, rm } = req.params;
    const { backupId } = req.body || {};
    const correlationId = nanoid();

    if (!backupId) {
      res.status(400).json({ error: 'backupId is required' });
      return;
    }

    publishCommand(correlationId, {
      type: 'deleteBackup',
      targetEndpointName: ep,
      targetReadModel: rm,
      backupId,
    });

    res.json({ status: 'deleting', correlationId });
  };

  const listBackups = (req, res) => {
    if (!validateReadModel(req, res)) return;
    const { ep, rm } = req.params;

    return sseClient
      .fetchBackupList(ep, rm)
      .then((backups) => {
        res.json(backups);
      })
      .catch((err) => {
        res.status(502).json({ error: err.message });
      });
  };

  // --- Lifecycle endpoints ---

  const activateAllRms = (req, res) => {
    const allRms = sseClient.cache.getAllReadModels();
    const keys = Object.keys(allRms);

    orchestrator.activateAll().catch((err) => {
      const log = getLogger('Admin/Activate', 'ALL');
      log.error(`Activate-all failed: ${err.message}`);
    });

    res.status(202).json({ status: 'activating', readModels: keys });
  };

  const activateRm = (req, res) => {
    const { ep, rm } = req.params;
    // Validate if cache is populated (skip during initial activation
    // when cache may be empty before RM discovery)
    const allRms = sseClient.cache.getAllReadModels();
    if (Object.keys(allRms).length > 0 && !allRms[`${ep}/${rm}`]) {
      res.status(404).json({ error: `Read model ${ep}/${rm} not found` });
      return;
    }
    const correlationId = nanoid();

    orchestrator.activationOrchestration(ep, rm).catch((err) => {
      const log = getLogger('Admin/Activate', correlationId);
      log.error(`Activation failed for ${ep}/${rm}: ${err.message}`);
    });

    res.status(202).json({
      status: 'activating',
      endpointName: ep,
      readModel: rm,
    });
  };

  const stopRm = (req, res) => {
    if (!validateReadModel(req, res)) return;
    const { ep, rm } = req.params;
    const correlationId = nanoid();

    publishCommand(correlationId, {
      type: 'stop',
      targetEndpointName: ep,
      targetReadModel: rm,
    });

    res.json({ status: 'stopping', endpointName: ep, readModel: rm });
  };

  const resetRm = (req, res) => {
    if (!validateReadModel(req, res)) return;
    const { ep, rm } = req.params;
    const correlationId = nanoid();

    publishCommand(correlationId, {
      type: 'reset',
      targetEndpointName: ep,
      targetReadModel: rm,
    });

    res.json({ status: 'resetting', endpointName: ep, readModel: rm });
  };

  return {
    readModelStatusAll,
    readModelStatusOne,
    commandProcessorStatus,
    sseStream,
    startReplay,
    cancelReplay,
    createBackup,
    cancelBackup,
    restoreBackup,
    deleteBackup,
    listBackups,
    activateAllRms,
    activateRm,
    stopRm,
    resetRm,
  };
};

const installAdminRoutes = ({ sseClient, orchestrator, eventBus, token }) => {
  const routes = createRoutes({ sseClient, orchestrator, eventBus, token });

  return (app) => {
    // Status
    app.get('/admin/readmodel/status', routes.readModelStatusAll);
    app.get('/admin/readmodel/status/:ep/:rm', routes.readModelStatusOne);
    app.get('/admin/commandprocessor/status', routes.commandProcessorStatus);
    app.get('/admin/events', routes.sseStream);

    // Replay
    app.post('/admin/replay/start/:ep/:rm', routes.startReplay);
    app.post('/admin/replay/cancel/:ep/:rm', routes.cancelReplay);

    // Backup
    app.post('/admin/backup/create/:ep/:rm', routes.createBackup);
    app.post('/admin/backup/cancel/:ep/:rm', routes.cancelBackup);
    app.post('/admin/backup/restore/:ep/:rm', routes.restoreBackup);
    app.post('/admin/backup/delete/:ep/:rm', routes.deleteBackup);
    app.get('/admin/backup/list/:ep/:rm', routes.listBackups);

    // Lifecycle — activate-all MUST be before parameterized routes
    app.post('/admin/readmodel/activate-all', routes.activateAllRms);
    app.post('/admin/readmodel/activate/:ep/:rm', routes.activateRm);
    app.post('/admin/readmodel/stop/:ep/:rm', routes.stopRm);
    app.post('/admin/readmodel/reset/:ep/:rm', routes.resetRm);
  };
};

export { installAdminRoutes, createRoutes };
