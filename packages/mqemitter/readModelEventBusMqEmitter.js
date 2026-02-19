import { getLogger } from '@lazyapps/logger';
import { getSharedMqEmitter } from './mqEmitterRegistry.js';

export const readModelEventBusMqEmitter =
  ({ mqName }) =>
  (context) => {
    let inReplay = false;

    const handleSysMessage = (msg) => {
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
          context.replayHandler.handleReplayComplete(msg.readModel);
          break;
        case 'REPLAY_CANCELLED':
          context.replayHandler.handleReplayCancelled(msg.readModel);
          break;
      }
    };

    const initLog = getLogger('RM/EB', 'INIT');

    return Promise.resolve(getSharedMqEmitter('INIT', mqName))
      .then((mq) => {
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
        mq.on('__system', ({ payload }, cb) => {
          const { correlationId, event } = payload;
          const log = getLogger('RM/EB', correlationId);
          log.debug(`Received '__system' event: ${JSON.stringify(event)}`);

          handleSysMessage(event);
          cb();
        });
        mq.on('__replay', ({ payload }, cb) => {
          const { correlationId, targetReadModel, event } = payload;
          const log = getLogger('RM/EB/Replay', correlationId);
          if (context.readModels[targetReadModel]) {
            log.debug(`Replay event for ${targetReadModel}: ${event.type}`);
            context.projectionHandler.projectEventForReadModel(
              correlationId,
              targetReadModel,
            )(event);
          }
          cb();
        });
      })
      .then(() => {
        initLog.debug(`Event bus receiving`);
      });
  };
