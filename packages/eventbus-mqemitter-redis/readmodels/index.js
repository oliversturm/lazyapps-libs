import pRetry from 'p-retry';

import { getLogger } from '@lazyapps/logger';
import { connect } from '../connect.js';

export const mqEmitterRedis =
  ({ host = '127.0.0.1', port = 6379 } = {}) =>
  (context) => {
    const initLog = getLogger('RM/EB/Redis', 'INIT');

    let inReplay = false;

    const handleSysMessage = (msg, correlationId) => {
      switch (msg.type) {
        case 'SET_REPLAY_STATE':
          if (msg.readModel) {
            context.projectionHandler.setReadModelReplayState(
              msg.readModel,
              msg.state,
            );
          } else {
            inReplay = msg.state;
          }
          break;
        case 'REPLAY_EVENTS_DONE':
          context.replayHandler.handleReplayComplete(
            msg.readModel,
            correlationId,
          );
          break;
        case 'REPLAY_CANCELLED':
          context.replayHandler.handleReplayCancelled(
            msg.readModel,
            correlationId,
          );
          break;
        case 'CATCHUP_EVENTS_DONE':
          if (context.catchupHandler) {
            context.catchupHandler.handleCatchupComplete(
              msg.readModel,
              msg.toTimestamp,
              correlationId,
            );
          }
          break;
        case 'CATCHUP_CANCELLED':
          if (context.catchupHandler) {
            context.catchupHandler.handleCatchupCancelled(
              msg.readModel,
              correlationId,
            );
          }
          break;
      }
    };

    const subscribeToEvents = (mq) => {
      mq.on('events', ({ payload }, cb) => {
        const { correlationId, event } = payload;
        const log = getLogger('RM/EB/Redis', correlationId);
        log.debug(`Received event: ${JSON.stringify(event)}`);
        context.projectionHandler.projectEvent(correlationId)(event, inReplay);

        cb();
      });
      initLog.debug('Subscribed to events topic');
    };

    return pRetry(() => connect({ host, port }), {
      onFailedAttempt: (error) => {
        initLog.error(
          `Attempt ${error.attemptNumber} failed connecting to Redis on port ${port}: '${error}'. Will retry another ${error.retriesLeft} times.`,
        );
      },
      retries: 10,
    })
      .catch((err) => {
        initLog.error(`Failed to connect to Redis on port ${port}: ${err}`);
      })
      .then((mq) => {
        context.publishAdminReply = (replyTopic, payload) => {
          mq.emit({ topic: replyTopic, payload });
        };
        if (context.deferEventsSubscription) {
          context.subscribeToEvents = () => {
            subscribeToEvents(mq);
            return Promise.resolve();
          };
          initLog.debug(
            'Deferred events subscription — waiting for activate()',
          );
        } else {
          subscribeToEvents(mq);
        }
        mq.on('__system', ({ payload }, cb) => {
          const { correlationId, event } = payload;
          const log = getLogger('RM/EB/Redis', correlationId);
          log.debug(`Received '__system' event: ${JSON.stringify(event)}`);

          handleSysMessage(event, correlationId);
          cb();
        });
        mq.on('__replay', ({ payload }, cb) => {
          const { correlationId, targetReadModel, event, targetEndpointName } =
            payload;
          const log = getLogger('RM/EB/Redis/Replay', correlationId);
          if (
            targetEndpointName &&
            context.endpointName &&
            targetEndpointName !== context.endpointName
          ) {
            cb();
            return;
          }
          if (context.readModels[targetReadModel]) {
            log.debug(`Replay event for ${targetReadModel}: ${event.type}`);
            context.projectionHandler.projectEventForReadModel(
              correlationId,
              targetReadModel,
            )(event);
          }
          cb();
        });
        mq.on('__catchup', ({ payload }, cb) => {
          const { correlationId, targetReadModel, event, targetEndpointName } =
            payload;
          const log = getLogger('RM/EB/Redis/CatchUp', correlationId);
          if (
            targetEndpointName &&
            context.endpointName &&
            targetEndpointName !== context.endpointName
          ) {
            cb();
            return;
          }
          if (context.readModels[targetReadModel]) {
            log.debug(`Catch-up event for ${targetReadModel}: ${event.type}`);
            context.projectionHandler.projectCatchupEventForReadModel(
              correlationId,
              targetReadModel,
            )(event);
          }
          cb();
        });
        mq.on('__admin', ({ payload }, cb) => {
          const { correlationId, instruction } = payload;
          const log = getLogger('RM/EB/Redis/Admin', correlationId);
          if (
            context.expectedAdminToken &&
            instruction.token !== context.expectedAdminToken
          ) {
            log.warn(
              `[${correlationId}] Rejected admin instruction: invalid token`,
            );
            cb();
            return;
          }
          if (
            instruction.targetEndpointName &&
            context.endpointName &&
            instruction.targetEndpointName !== context.endpointName
          ) {
            log.debug(
              `Ignoring admin instruction for endpoint '${instruction.targetEndpointName}'`,
            );
            cb();
            return;
          }
          if (
            instruction.targetReadModel &&
            !context.readModels[instruction.targetReadModel]
          ) {
            log.debug(
              `Ignoring admin instruction for unknown read model '${instruction.targetReadModel}'`,
            );
            cb();
            return;
          }
          log.debug(
            `Received admin instruction: ${instruction.type} for ${instruction.targetReadModel || 'all'}`,
          );
          if (context.adminInstructionHandler) {
            context.adminInstructionHandler(correlationId, instruction);
          }
          cb();
        });
      })
      .then(() => {
        initLog.info(`Event bus connected at ${host}:${port}`);
      });
  };
