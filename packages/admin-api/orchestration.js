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

  const resolveReplayTimestamp = (ep, rm, options, log) => {
    const { t0Option, customTimestamp } = options;

    if (!t0Option) {
      // Standard replay: use the RM's last projected timestamp from cache
      const rmStatus = sseClient.cache.getReadModel(ep, rm);
      return Promise.resolve(rmStatus?.lastProjectedEventTimestamp || 0);
    }

    if (t0Option === 'replayToCurrentTime') {
      log.info('T=0 option 1: fetching last event store timestamp');
      return sseClient.fetchLastEventStoreTimestamp().then((ts) => {
        if (ts === null || ts === undefined) {
          throw new Error(
            'Cannot use replayToCurrentTime: event store timestamp unavailable',
          );
        }
        return ts;
      });
    }

    if (t0Option === 'customBoundary') {
      if (customTimestamp === null || customTimestamp === undefined) {
        return Promise.reject(
          new Error('customBoundary requires a customTimestamp value'),
        );
      }
      log.info(`T=0 option 3: using custom boundary ${customTimestamp}`);
      return Promise.resolve(customTimestamp);
    }

    if (t0Option === 'skipReplayCatchUpOnly') {
      // Handled separately — should not reach here
      return Promise.resolve(0);
    }

    return Promise.reject(new Error(`Unknown t0Option: ${t0Option}`));
  };

  const persistTimestampToBothStorages = (correlationId, ep, rm, timestamp) => {
    // Publish an admin instruction to write the timestamp to both
    // primary and secondary storage on the RM service side
    publishCommand(correlationId, {
      type: 'persistTimestamp',
      targetEndpointName: ep,
      targetReadModel: rm,
      timestamp,
    });
    return Promise.resolve();
  };

  const replayOrchestration = (ep, rm, options = {}) => {
    const correlationId = nanoid();
    const log = getLogger('Admin/Replay', correlationId);
    const {
      backupId,
      autoBackup,
      activateAfter = true,
      t0Option,
      customTimestamp,
      timestampOverride,
    } = options;

    log.info(`Starting replay orchestration for ${ep}/${rm}`);

    // Option 2: skipReplayCatchUpOnly — skip replay entirely
    if (t0Option === 'skipReplayCatchUpOnly') {
      log.info('T=0 option 2: skipping replay, catch-up only');
      if (!activateAfter) {
        log.warn(
          'skipReplayCatchUpOnly with activateAfter=false is ineffectual — ' +
            'the RM will remain stopped with no data',
        );
      }
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
          // Step 2: Reset storage
          log.info('Step 2: Resetting RM storage');
          publishCommand(correlationId, {
            type: 'reset',
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
            log.info('Skip-replay complete, chaining to activation');
            return activationOrchestration(ep, rm);
          }
          log.info(
            'Skip-replay complete, staying stopped (activateAfter=false)',
          );
          return {
            status: 'stopped',
            endpointName: ep,
            readModel: rm,
            warning: 'skipReplayCatchUpOnly with activateAfter=false',
          };
        })
        .then((result) => {
          sseClient.endOperation();
          return result;
        })
        .catch((err) => {
          log.error(`Skip-replay orchestration failed: ${err.message}`);
          sseClient.endOperation();
          throw err;
        });
    }

    // Standard replay or T=0 options 1/3
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
        // Step 1b: Dev-mode timestamp override — persist before resolving
        if (timestampOverride !== undefined && timestampOverride !== null) {
          log.info(
            `Step 1b: Dev-mode timestamp override = ${timestampOverride}`,
          );
          return persistTimestampToBothStorages(
            correlationId,
            ep,
            rm,
            timestampOverride,
          ).then(() =>
            // Allow SSE cache to pick up the new timestamp
            sseClient.fetchAllStatus(),
          );
        }
      })
      .then(() =>
        // Step 2: Resolve the replay timestamp
        resolveReplayTimestamp(ep, rm, options, log).then((lastTimestamp) => {
          log.info(`Step 2: replay toTimestamp = ${lastTimestamp}`);
          return lastTimestamp;
        }),
      )
      .then((lastTimestamp) => {
        // Step 2b: For T=0 options, persist the resolved timestamp
        // to both storages so the RM starts with the right boundary
        if (t0Option && lastTimestamp > 0) {
          log.info(
            `Step 2b: Persisting timestamp ${lastTimestamp} to both storages`,
          );
          return persistTimestampToBothStorages(
            correlationId,
            ep,
            rm,
            lastTimestamp,
          ).then(() => lastTimestamp);
        }
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

  const backupReplayOrchestration = (ep, rm, options = {}) => {
    const correlationId = nanoid();
    const log = getLogger('Admin/BackupReplay', correlationId);
    const {
      backupId,
      activateAfter = true,
      t0Option,
      customTimestamp,
      timestampOverride,
    } = options;

    log.info(
      `Starting backup replay orchestration for ${ep}/${rm} ` +
        `(backup=${backupId}, t0Option=${t0Option})`,
    );

    let rememberedLastEventTs = null;

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
        // Step 2: Pre-fetch last event store timestamp (needed for acceptLastEvent)
        if (t0Option === 'acceptLastEvent') {
          log.info('Step 2: Fetching last event store timestamp');
          return sseClient.fetchLastEventStoreTimestamp().then((ts) => {
            if (ts === null || ts === undefined) {
              throw new Error(
                'Cannot use acceptLastEvent: event store timestamp unavailable',
              );
            }
            rememberedLastEventTs = ts;
            log.info(`Step 2: Last event store timestamp = ${ts}`);
          });
        }
        return Promise.resolve();
      })
      .then(() => {
        // Step 3: Restore backup
        log.info(`Step 3: Restoring backup ${backupId}`);
        publishCommand(correlationId, {
          type: 'restoreBackup',
          targetEndpointName: ep,
          targetReadModel: rm,
          backupId,
        });

        // Wait for restore to start (backupProgress.state === 'restoring')
        return sseClient
          .waitForStatus((status) => {
            const rmStatus = status.readModels[`${ep}/${rm}`];
            return rmStatus?.backupProgress?.state === 'restoring';
          }, STEP_TIMEOUT_MS)
          .then(() => {
            log.info('Step 3: Restore started, waiting for completion');
            // Wait for restore to complete (backupProgress.state back to 'idle')
            return sseClient.waitForStatus((status) => {
              const rmStatus = status.readModels[`${ep}/${rm}`];
              return (
                rmStatus &&
                rmStatus.state === 'stopped' &&
                rmStatus.backupProgress?.state === 'idle'
              );
            }, STEP_TIMEOUT_MS);
          });
      })
      .then(() => {
        // Step 4: Read the backup's timestamp from RM status
        return sseClient.fetchAllStatus().then(() => {
          const rmStatus = sseClient.cache.getReadModel(ep, rm);
          const backupTimestamp = rmStatus?.lastProjectedEventTimestamp || 0;
          log.info(`Step 4: Backup timestamp = ${backupTimestamp}`);
          return backupTimestamp;
        });
      })
      .then((backupTimestamp) => {
        // Step 4b: Dev-mode timestamp override — replace backup timestamp
        if (timestampOverride !== undefined && timestampOverride !== null) {
          log.info(
            `Step 4b: Dev-mode timestamp override = ${timestampOverride} ` +
              `(was ${backupTimestamp})`,
          );
          return persistTimestampToBothStorages(
            correlationId,
            ep,
            rm,
            timestampOverride,
          ).then(() => timestampOverride);
        }
        return backupTimestamp;
      })
      .then((backupTimestamp) => {
        // Step 5: Determine replay boundary based on t0Option
        if (t0Option === 'acceptBackupTimestamp') {
          log.info('T=0 backup option 2: using backup timestamp, skip replay');
          if (!activateAfter) {
            log.warn(
              'acceptBackupTimestamp with activateAfter=false — ' +
                'RM stays stopped at backup state',
            );
          }
          // Persist backup timestamp to both storages
          return persistTimestampToBothStorages(
            correlationId,
            ep,
            rm,
            backupTimestamp,
          ).then(() => {
            if (activateAfter) {
              log.info('Backup restore complete, chaining to activation');
              return activationOrchestration(ep, rm);
            }
            return {
              status: 'stopped',
              endpointName: ep,
              readModel: rm,
            };
          });
        }

        // For acceptLastEvent and customBoundary, we need to replay
        const replayBoundary =
          t0Option === 'acceptLastEvent'
            ? rememberedLastEventTs
            : customTimestamp;

        if (replayBoundary === null || replayBoundary === undefined) {
          throw new Error(`${t0Option} requires a valid timestamp boundary`);
        }

        log.info(
          `T=0 backup: replaying from ${backupTimestamp} to ${replayBoundary}`,
        );

        // Persist the replay boundary to both storages
        return persistTimestampToBothStorages(
          correlationId,
          ep,
          rm,
          replayBoundary,
        )
          .then(() => {
            // Fetch replayRelevantEvents
            log.info('Fetching replayRelevantEvents');
            return sseClient.fetchReplayRelevantEvents(ep, rm);
          })
          .then((replayRelevantEvents) => {
            // Send startReplay to RM
            log.info('Sending startReplay command');
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
              .then(() => replayRelevantEvents);
          })
          .then((replayRelevantEvents) => {
            // Send replay command to CP — from backupTimestamp to boundary
            log.info(
              `Sending replay command to CP ` +
                `(from=${backupTimestamp}, to=${replayBoundary})`,
            );
            publishCommand(correlationId, {
              type: 'replay',
              readModel: rm,
              targetEndpointName: ep,
              fromTimestamp: backupTimestamp,
              toTimestamp: replayBoundary,
              replayRelevantEvents,
            });

            // Wait for CP replay completion
            log.info('Waiting for CP replay completion');
            return sseClient.fetchAllStatus().then(() =>
              sseClient.waitForStatus((status) => {
                const cp = status.commandProcessor;
                if (!cp) return false;
                const hasActiveReplay = (cp.activeReplays || []).some(
                  (r) => r.readModel === rm && r.targetEndpointName === ep,
                );
                return !hasActiveReplay;
              }, 300000),
            );
          })
          .then(() => {
            // Send replayDone, await stopped
            log.info('Sending replayDone command');
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
              log.info('Backup replay complete, chaining to activation');
              return activationOrchestration(ep, rm);
            }
            log.info(
              'Backup replay complete, staying stopped (activateAfter=false)',
            );
            return { status: 'stopped', endpointName: ep, readModel: rm };
          });
      })
      .then((result) => {
        sseClient.endOperation();
        return result;
      })
      .catch((err) => {
        log.error(`Backup replay orchestration failed: ${err.message}`);
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

  const activationOrchestration = (ep, rm, options) => {
    const { skipCatchup } = options || {};
    const correlationId = nanoid();
    const log = getLogger('Admin/Activate', correlationId);

    log.info(
      `Starting activation for ${ep}/${rm}${skipCatchup ? ' (skip catchup)' : ''}`,
    );

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
        if (skipCatchup) {
          // Skip catch-up: go directly to catchupDone → live
          log.info('Skipping catch-up (skipCatchup=true)');
          publishCommand(correlationId, {
            type: 'catchupDone',
            targetEndpointName: ep,
            targetReadModel: rm,
          });

          return sseClient.waitForStatus((status) => {
            const rmStatus = status.readModels[`${ep}/${rm}`];
            return rmStatus && rmStatus.state === 'live';
          }, STEP_TIMEOUT_MS);
        }

        // Step 2: Query lastProjectedEventTimestamp and replayRelevantEvents
        const rmStatus = sseClient.cache.getReadModel(ep, rm);
        const fromTimestamp = rmStatus?.lastProjectedEventTimestamp || 0;
        log.info(`Step 2: fromTimestamp = ${fromTimestamp}`);

        return sseClient
          .fetchReplayRelevantEvents(ep, rm)
          .then((events) => ({ fromTimestamp, replayRelevantEvents: events }));
      })
      .then((result) => {
        if (skipCatchup) {
          // Already resolved to live state
          log.info(`Activation complete for ${ep}/${rm} (skipped catchup)`);
          return { status: 'live', endpointName: ep, readModel: rm };
        }

        const { fromTimestamp, replayRelevantEvents } = result;
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
      .then((result) => {
        if (skipCatchup) return result;

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
      .then((result) => {
        if (skipCatchup) return result;
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
    backupReplayOrchestration,
    cancelReplayOrchestration,
    activationOrchestration,
    activateAll,
  };
};

export { createOrchestrator };
