import { getLogger } from '@lazyapps/logger';
import { getSharedMqEmitter } from './mqEmitterRegistry.js';

export const readModelEventBusMqEmitter =
  ({ mqName }) =>
  (context) => {
    const initLog = getLogger('RM/EB', 'INIT');

    const subscribeToEvents = (mq) => {
      mq.on('events', ({ payload }, cb) => {
        const { correlationId } = payload;
        const log = getLogger('RM/EB', correlationId);
        log.debug(`Received event: ${JSON.stringify(payload)}`);
        context.projectionHandler.projectEvent(correlationId)(payload, false);

        cb();
      });
      initLog.debug('Subscribed to events topic');
    };

    return Promise.resolve(getSharedMqEmitter('INIT', mqName))
      .then((mq) => {
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
        mq.on('__replay', ({ payload }, cb) => {
          const { correlationId, targetReadModel, event, targetEndpointName } =
            payload;
          const log = getLogger('RM/EB/Replay', correlationId);
          if (
            targetEndpointName &&
            context.endpointName &&
            targetEndpointName !== context.endpointName
          ) {
            cb();
            return;
          }
          if (context.readModels[targetReadModel]) {
            log.debug(
              `Replay event for ${targetReadModel}: ${JSON.stringify(event)}`,
            );
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
          const log = getLogger('RM/EB/CatchUp', correlationId);
          if (
            targetEndpointName &&
            context.endpointName &&
            targetEndpointName !== context.endpointName
          ) {
            cb();
            return;
          }
          if (context.readModels[targetReadModel]) {
            log.debug(
              `Catch-up event for ${targetReadModel}: ${JSON.stringify(event)}`,
            );
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
        initLog.debug(`Message bus receiving`);
      });
  };
