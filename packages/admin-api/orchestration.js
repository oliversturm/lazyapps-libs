import { getLogger } from '@lazyapps/logger';
import { nanoid } from 'nanoid';

const STEP_TIMEOUT_MS = 10000;

const createOrchestrator = ({ sseClient, eventBus, token }) => {
  const publishCommand = (correlationId, command) => {
    eventBus.publishAdminInstruction(correlationId)({
      ...command,
      correlationId,
      ...(token && { token }),
    });
  };

  const replayOrchestration = (ep, rm, options = {}) => {
    const correlationId = nanoid();
    const log = getLogger('Admin/Replay', correlationId);
    const { backupId, autoBackup, activateAfter = true } = options;

    log.info(`Starting replay orchestration for ${ep}/${rm}`);

    return sseClient
      .startOperation()
      .then(() => {
        // Step 1: Stop the RM
        log.info('Step 1: Sending stop command');
        publishCommand(correlationId, {
          type: 'stop',
          targetEndpointName: ep,
          targetReadModel: rm,
        });

        return sseClient.waitForStatus((status) => {
          const rmStatus = status.readModels[`${ep}/${rm}`];
          return rmStatus && rmStatus.state === 'stopped';
        }, STEP_TIMEOUT_MS);
      })
      .then(() => {
        // Step 2: Get lastProjectedEventTimestamp from cache
        const rmStatus = sseClient.cache.getReadModel(ep, rm);
        const lastTimestamp = rmStatus?.lastProjectedEventTimestamp || 0;
        log.info(`Step 2: lastProjectedEventTimestamp = ${lastTimestamp}`);
        return lastTimestamp;
      })
      .then((lastTimestamp) => {
        // Step 3: Optional auto-backup
        if (!autoBackup) return lastTimestamp;

        log.info('Step 3: Creating auto-backup');
        publishCommand(correlationId, {
          type: 'createBackup',
          targetEndpointName: ep,
          targetReadModel: rm,
        });

        return sseClient
          .waitForStatus((status) => {
            const rmStatus = status.readModels[`${ep}/${rm}`];
            return (
              rmStatus &&
              rmStatus.backupProgress &&
              rmStatus.backupProgress.state === 'idle'
            );
          }, 60000)
          .then(() => lastTimestamp);
      })
      .then((lastTimestamp) => {
        // Step 4: Reset or restore backup
        if (backupId) {
          log.info(`Step 4: Restoring backup ${backupId}`);
          publishCommand(correlationId, {
            type: 'restoreBackup',
            targetEndpointName: ep,
            targetReadModel: rm,
            backupId,
          });
        } else {
          log.info('Step 4: Resetting RM storage');
          publishCommand(correlationId, {
            type: 'reset',
            targetEndpointName: ep,
            targetReadModel: rm,
          });
        }

        return sseClient
          .waitForStatus((status) => {
            const rmStatus = status.readModels[`${ep}/${rm}`];
            return rmStatus && rmStatus.state === 'stopped';
          }, STEP_TIMEOUT_MS)
          .then(() => lastTimestamp);
      })
      .then((lastTimestamp) => {
        // Step 5: Query replayRelevantEvents
        log.info('Step 5: Fetching replayRelevantEvents');
        return sseClient
          .fetchReplayRelevantEvents(ep, rm)
          .then((events) => ({ lastTimestamp, replayRelevantEvents: events }));
      })
      .then(({ lastTimestamp, replayRelevantEvents }) => {
        // Step 6: Send startReplay to RM
        log.info('Step 6: Sending startReplay command');
        publishCommand(correlationId, {
          type: 'startReplay',
          targetEndpointName: ep,
          targetReadModel: rm,
        });

        return sseClient
          .waitForStatus((status) => {
            const rmStatus = status.readModels[`${ep}/${rm}`];
            return rmStatus && rmStatus.state === 'replay';
          }, STEP_TIMEOUT_MS)
          .then(() => ({ lastTimestamp, replayRelevantEvents }));
      })
      .then(({ lastTimestamp, replayRelevantEvents }) => {
        // Step 7: Send replay command to CP
        log.info(
          `Step 7: Sending replay command to CP (toTimestamp=${lastTimestamp})`,
        );
        publishCommand(correlationId, {
          type: 'replay',
          readModel: rm,
          targetEndpointName: ep,
          fromTimestamp: 0,
          toTimestamp: lastTimestamp,
          replayRelevantEvents,
        });

        // Step 8: Await CP replay done — refresh cache first so we
        // don't resolve immediately against stale "no active replay"
        log.info('Step 8: Waiting for CP replay completion');
        return sseClient.fetchAllStatus().then(() =>
          sseClient.waitForStatus(
            (status) => {
              const cp = status.commandProcessor;
              if (!cp) return false;
              const hasActiveReplay = (cp.activeReplays || []).some(
                (r) => r.readModel === rm && r.targetEndpointName === ep,
              );
              return !hasActiveReplay;
            },
            300000, // 5 minute timeout for replay
          ),
        );
      })
      .then(() => {
        // Step 9: Send replayDone, await stopped, then activate
        log.info('Step 9: Sending replayDone command');
        publishCommand(correlationId, {
          type: 'replayDone',
          targetEndpointName: ep,
          targetReadModel: rm,
        });

        return sseClient.waitForStatus((status) => {
          const rmStatus = status.readModels[`${ep}/${rm}`];
          return rmStatus && rmStatus.state === 'stopped';
        }, STEP_TIMEOUT_MS);
      })
      .then(() => {
        if (activateAfter) {
          log.info('Replay complete, chaining to activation');
          return activationOrchestration(ep, rm);
        }
        log.info('Replay complete, staying stopped (activateAfter=false)');
        return { status: 'stopped', endpointName: ep, readModel: rm };
      })
      .then((result) => {
        sseClient.endOperation();
        return result;
      })
      .catch((err) => {
        log.error(`Replay orchestration failed: ${err.message}`);
        sseClient.endOperation();
        throw err;
      });
  };

  const cancelReplayOrchestration = (ep, rm, options = {}) => {
    const correlationId = nanoid();
    const log = getLogger('Admin/Replay', correlationId);

    log.info(`Cancelling replay for ${ep}/${rm}`);

    // Cancel on CP side
    publishCommand(correlationId, {
      type: 'cancelReplay',
      readModel: rm,
      targetEndpointName: ep,
    });

    // Send replayDone to RM to transition back to stopped
    publishCommand(correlationId, {
      type: 'replayDone',
      targetEndpointName: ep,
      targetReadModel: rm,
    });

    if (options.reset) {
      publishCommand(correlationId, {
        type: 'reset',
        targetEndpointName: ep,
        targetReadModel: rm,
      });
    }

    return Promise.resolve({ status: 'cancelling', correlationId });
  };

  const activationOrchestration = (ep, rm) => {
    const correlationId = nanoid();
    const log = getLogger('Admin/Activate', correlationId);

    log.info(`Starting activation for ${ep}/${rm}`);

    return sseClient
      .ensureConnected()
      .then(() => {
        // Step 1: Send activate command to RM
        log.info('Step 1: Sending activate command');
        publishCommand(correlationId, {
          type: 'activate',
          targetEndpointName: ep,
          targetReadModel: rm,
        });

        return sseClient.fetchAllStatus().then(() =>
          sseClient.waitForStatus((status) => {
            const rmStatus = status.readModels[`${ep}/${rm}`];
            return rmStatus && rmStatus.state === 'catchup';
          }, STEP_TIMEOUT_MS),
        );
      })
      .then(() => {
        // Step 2: Query lastProjectedEventTimestamp and replayRelevantEvents
        const rmStatus = sseClient.cache.getReadModel(ep, rm);
        const fromTimestamp = rmStatus?.lastProjectedEventTimestamp || 0;
        log.info(`Step 2: fromTimestamp = ${fromTimestamp}`);

        return sseClient
          .fetchReplayRelevantEvents(ep, rm)
          .then((events) => ({ fromTimestamp, replayRelevantEvents: events }));
      })
      .then(({ fromTimestamp, replayRelevantEvents }) => {
        // Step 3: Send startCatchup to CP
        log.info(`Step 3: Sending startCatchup to CP (from ${fromTimestamp})`);
        publishCommand(correlationId, {
          type: 'startCatchup',
          readModel: rm,
          targetEndpointName: ep,
          fromTimestamp,
          replayRelevantEvents,
        });

        // Step 4: Await CP catchup done — refresh cache first so we
        // don't resolve immediately against stale "no active catchup"
        log.info('Step 4: Waiting for CP catchup completion');
        return sseClient.fetchAllStatus().then(() =>
          sseClient.waitForStatus(
            (status) => {
              const cp = status.commandProcessor;
              if (!cp) return false;
              const hasActiveCatchup = (cp.activeCatchUps || []).some(
                (c) => c.readModel === rm && c.targetEndpointName === ep,
              );
              return !hasActiveCatchup;
            },
            300000, // 5 minute timeout
          ),
        );
      })
      .then(() => {
        // Step 5: Send catchupDone to RM
        log.info('Step 5: Sending catchupDone command');
        publishCommand(correlationId, {
          type: 'catchupDone',
          targetEndpointName: ep,
          targetReadModel: rm,
        });

        // Step 6: Await state=live
        log.info('Step 6: Waiting for live state');
        return sseClient.waitForStatus((status) => {
          const rmStatus = status.readModels[`${ep}/${rm}`];
          return rmStatus && rmStatus.state === 'live';
        }, STEP_TIMEOUT_MS);
      })
      .then(() => {
        log.info(`Activation complete for ${ep}/${rm}`);
        return { status: 'live', endpointName: ep, readModel: rm };
      });
  };

  const activateAll = () => {
    const log = getLogger('Admin/Activate', 'ALL');
    const allRms = sseClient.cache.getAllReadModels();
    const keys = Object.keys(allRms);

    if (keys.length === 0) {
      log.info('No read models discovered, nothing to activate');
      return Promise.resolve([]);
    }

    log.info(`Activating all read models: ${keys.join(', ')}`);

    return sseClient
      .startOperation()
      .then(() =>
        Promise.all(
          keys.map((key) => {
            const rm = allRms[key];
            return activationOrchestration(
              rm.endpointName,
              rm.readModelName,
            ).catch((err) => {
              log.error(`Activation failed for ${key}: ${err.message}`);
              return { status: 'error', key, error: err.message };
            });
          }),
        ),
      )
      .then((results) => {
        sseClient.endOperation();
        return results;
      })
      .catch((err) => {
        sseClient.endOperation();
        throw err;
      });
  };

  return {
    replayOrchestration,
    cancelReplayOrchestration,
    activationOrchestration,
    activateAll,
  };
};

export { createOrchestrator };
