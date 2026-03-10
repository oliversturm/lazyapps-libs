import { getLogger } from '@lazyapps/logger';
import { getSharedMqEmitter } from './mqEmitterRegistry.js';

export const readModelEventBusMqEmitter =
  ({ mqName }) =>
  (context) => {
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

    const initLog = getLogger('RM/EB', 'INIT');

    const subscribeToEvents = (mq) => {
      mq.on('events', ({ payload }, cb) => {
        const { correlationId } = payload;
        const log = getLogger('RM/EB', correlationId);
        log.debug(`Received event: ${JSON.stringify(payload)}`);
        context.projectionHandler.projectEvent(correlationId)(
          payload,
          inReplay,
        );

        cb();
      });
      initLog.debug('Subscribed to events topic');
    };

    return Promise.resolve(getSharedMqEmitter('INIT', mqName))
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
          const log = getLogger('RM/EB', correlationId);
          log.debug(`Received '__system' event: ${JSON.stringify(event)}`);

          handleSysMessage(event, correlationId);
          cb();
        });
        mq.on('__replay', ({ payload }, cb) => {
          const { correlationId, targetReadModel, event, targetServiceId } =
            payload;
          const log = getLogger('RM/EB/Replay', correlationId);
          if (
            targetServiceId &&
            context.correlationConfig &&
            targetServiceId !== context.correlationConfig.serviceId
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
          const { correlationId, targetReadModel, event, targetServiceId } =
            payload;
          const log = getLogger('RM/EB/CatchUp', correlationId);
          if (
            targetServiceId &&
            context.correlationConfig &&
            targetServiceId !== context.correlationConfig.serviceId
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
          const log = getLogger('RM/EB/Admin', correlationId);
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
            instruction.targetServiceId &&
            context.correlationConfig &&
            instruction.targetServiceId !== context.correlationConfig.serviceId
          ) {
            log.debug(
              `Ignoring admin instruction for service '${instruction.targetServiceId}'`,
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
        initLog.debug(`Event bus receiving`);
      });
  };
