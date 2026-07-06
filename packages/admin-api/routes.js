import { getLogger } from '@lazyapps/logger';
import { nanoid } from 'nanoid';
import { getPreflightStatus } from './preflightCheck.js';
import { parseFilter } from './sideEffectFilter.js';

const createRoutes = ({
  sseClient,
  orchestrator,
  eventBus,
  token,
  developmentMode = false,
  // Interval between browser SSE heartbeat comments. Heartbeats force writes
  // on the socket so a dead browser connection (no clean 'close') surfaces as
  // a write error and releases its refcount — see sseStream below.
  heartbeatMs = 15000,
}) => {
  const publishCommand = (correlationId, command) => {
    eventBus.publishAdminInstruction(correlationId)({
      ...command,
      correlationId,
      ...(token && { token }),
    });
  };

  // While no SSE subscriptions are connected (on-demand lifecycle), the
  // status cache can be cold or stale — refresh it via a plain HTTP fetch
  // before handling requests that read from it. Does not bring up SSE.
  const withFreshCache = (handler) => (req, res) => {
    if (sseClient.isConnected()) return handler(req, res);
    const log = getLogger('Admin/Routes', 'CACHE');
    log.debug(`SSE not connected — refreshing status cache for ${req.path}`);
    return sseClient.fetchAllStatus().then(() => handler(req, res));
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

  // --- Admin config endpoint ---

  const adminConfig = (req, res) => {
    res.json({ developmentMode: !!developmentMode });
  };

  const validateFilter = (req, res) => {
    const { filterString } = req.body || {};
    if (typeof filterString !== 'string') {
      res.status(400).json({ filter: null, error: 'filterString is required' });
      return;
    }
    const result = parseFilter(filterString);
    res.json(result);
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
    const log = getLogger('Admin/Routes', 'SSE');

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

    // Single teardown path shared by clean close, response errors, and
    // heartbeat write failures. Guarded so the refcount is released exactly
    // once no matter how many of those fire (a dropped connection can raise
    // both an 'error' and a 'close', or a heartbeat failure then a 'close').
    let cleanedUp = false;
    let heartbeatTimer = null;
    const cleanup = (reason) => {
      if (cleanedUp) return;
      cleanedUp = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      sseClient.emitter.off('readmodel-status', onRmStatus);
      sseClient.emitter.off('commandprocessor-status', onCpStatus);
      sseClient.removeBrowserClient();
      log.debug(`Browser SSE stream closed (${reason})`);
    };

    sseClient.addBrowserClient().catch((err) => {
      log.warn(`SSE upstream connect on browser attach failed: ${err.message}`);
    });
    sseClient.emitter.on('readmodel-status', onRmStatus);
    sseClient.emitter.on('commandprocessor-status', onCpStatus);

    // Periodic heartbeat: without it, a browser connection that dies without a
    // clean TCP close (network drop, sleeping laptop) never emits 'close', so
    // its refcount stays pinned and upstream RM/CP SSE is held open
    // indefinitely (issue #16). Writing forces the TCP stack to notice the
    // dead peer, surfacing an error we treat as a disconnect.
    heartbeatTimer = setInterval(() => {
      try {
        res.write(':heartbeat\n\n');
      } catch (err) {
        log.warn(
          `Heartbeat write failed — releasing browser client: ${err.message}`,
        );
        cleanup('heartbeat-write-failed');
        try {
          res.end();
        } catch {
          // Socket already destroyed — nothing more to do.
        }
      }
    }, heartbeatMs);
    // Don't keep the process alive just to heartbeat a browser connection.
    if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();

    req.on('close', () => cleanup('client-close'));
    res.on('error', (err) => {
      log.warn(`SSE response error — releasing browser client: ${err.message}`);
      cleanup('response-error');
    });
  };

  // --- Preflight endpoint ---

  const replayPreflight = (req, res) => {
    const { ep, rm } = req.params;
    const rmStatus = sseClient.cache.getReadModel(ep, rm);

    if (!rmStatus) {
      res.status(404).json({ error: `Read model ${ep}/${rm} not found` });
      return;
    }

    // Fetch last event store timestamp from CP if available
    return sseClient
      .fetchLastEventStoreTimestamp()
      .then((lastEventStoreTimestamp) => {
        const preflight = getPreflightStatus(rmStatus, lastEventStoreTimestamp);
        res.json(preflight);
      })
      .catch(() => {
        // If we can't reach the event store, still return what we know
        const preflight = getPreflightStatus(rmStatus, null);
        res.json(preflight);
      });
  };

  // --- Replay endpoints ---

  const startReplay = (req, res) => {
    const { ep, rm } = req.params;
    const {
      backupId,
      autoBackup,
      activateAfter,
      t0Option,
      customTimestamp,
      timestampOverride,
      replayDelayMs,
    } = req.body || {};
    const correlationId = nanoid();
    const log = getLogger('Admin/Replay', correlationId);

    log.info(`Replay requested for ${ep}/${rm}`);

    if (timestampOverride !== undefined && !developmentMode) {
      res
        .status(403)
        .json({ error: 'timestampOverride requires development mode' });
      return;
    }

    // Route to backup replay orchestration when both backupId and t0Option
    // are present (backup restore with T=0 handling)
    const orchestration =
      backupId && t0Option
        ? orchestrator.backupReplayOrchestration(ep, rm, {
            backupId,
            activateAfter,
            t0Option,
            customTimestamp,
            timestampOverride,
            replayDelayMs,
          })
        : orchestrator.replayOrchestration(ep, rm, {
            backupId,
            autoBackup,
            activateAfter,
            t0Option,
            customTimestamp,
            timestampOverride,
            replayDelayMs,
          });

    // Fire off orchestration — don't await, return immediately
    orchestration.catch((err) => {
      log.error(`Replay orchestration failed for ${ep}/${rm}: ${err.message}`);
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

    const { skipCatchup } = req.body || {};

    if (skipCatchup && !developmentMode) {
      res.status(403).json({ error: 'skipCatchup requires development mode' });
      return;
    }

    orchestrator
      .activationOrchestration(ep, rm, { skipCatchup })
      .catch((err) => {
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

  const dismissInvalid = (req, res) => {
    if (!developmentMode) {
      res.status(403).json({ error: 'Development mode only' });
      return;
    }
    if (!validateReadModel(req, res)) return;
    const { ep, rm } = req.params;
    const correlationId = nanoid();

    publishCommand(correlationId, {
      type: 'dismissInvalid',
      targetEndpointName: ep,
      targetReadModel: rm,
      developmentOperation: true,
    });

    res.json({ status: 'dismissing', endpointName: ep, readModel: rm });
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
    adminConfig,
    validateFilter,
    readModelStatusAll: withFreshCache(readModelStatusAll),
    readModelStatusOne: withFreshCache(readModelStatusOne),
    commandProcessorStatus: withFreshCache(commandProcessorStatus),
    sseStream,
    replayPreflight: withFreshCache(replayPreflight),
    startReplay,
    cancelReplay,
    createBackup: withFreshCache(createBackup),
    cancelBackup: withFreshCache(cancelBackup),
    restoreBackup: withFreshCache(restoreBackup),
    deleteBackup: withFreshCache(deleteBackup),
    listBackups: withFreshCache(listBackups),
    activateAllRms: withFreshCache(activateAllRms),
    activateRm: withFreshCache(activateRm),
    dismissInvalid: withFreshCache(dismissInvalid),
    stopRm: withFreshCache(stopRm),
    resetRm: withFreshCache(resetRm),
  };
};

const installAdminRoutes = ({
  sseClient,
  orchestrator,
  eventBus,
  token,
  developmentMode,
  heartbeatMs,
}) => {
  const routes = createRoutes({
    sseClient,
    orchestrator,
    eventBus,
    token,
    developmentMode,
    heartbeatMs,
  });

  return (app) => {
    // Config
    app.get('/admin/config', routes.adminConfig);
    app.post('/admin/validate-filter', routes.validateFilter);

    // Status
    app.get('/admin/readmodel/status', routes.readModelStatusAll);
    app.get('/admin/readmodel/status/:ep/:rm', routes.readModelStatusOne);
    app.get('/admin/commandprocessor/status', routes.commandProcessorStatus);
    app.get('/admin/events', routes.sseStream);

    // Replay
    app.get('/admin/replay/preflight/:ep/:rm', routes.replayPreflight);
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
    app.post('/admin/readmodel/dismiss-invalid/:ep/:rm', routes.dismissInvalid);
    app.post('/admin/readmodel/stop/:ep/:rm', routes.stopRm);
    app.post('/admin/readmodel/reset/:ep/:rm', routes.resetRm);
  };
};

export { installAdminRoutes, createRoutes };
