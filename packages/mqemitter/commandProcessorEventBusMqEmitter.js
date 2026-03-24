import { getLogger } from '@lazyapps/logger';
import { trace } from '@opentelemetry/api';
import { getSharedMqEmitter } from './mqEmitterRegistry.js';

const tracer = trace.getTracer('@lazyapps/mqemitter');

export const commandProcessorEventBusMqEmitter =
  ({ mqName }) =>
  () => {
    const initLog = getLogger('CP/EB/MQE', 'INIT');

    return Promise.resolve(getSharedMqEmitter('INIT', mqName))
      .then((mq) => ({
        publishEvent: (correlationId) => (event) => {
          const log = getLogger('CP/EB/MQE', correlationId);
          log.debug(`Publishing event timestamp ${event.timestamp}`);
          event.correlationId = correlationId;
          const span = tracer.startSpan('lazyapps.mqemitter.emit', {
            attributes: { topic: 'events' },
          });
          mq.emit({ topic: 'events', payload: event });
          span.end();
          return event;
        },
        publishReplayEvent:
          (correlationId) => (targetReadModel, event, targetEndpointName) => {
            const log = getLogger('CP/EB/MQE', correlationId);
            log.debug(
              `Publishing replay event for ${targetReadModel}: ${JSON.stringify(event)}`,
            );
            mq.emit({
              topic: '__replay',
              payload: {
                correlationId,
                targetReadModel,
                event,
                ...(targetEndpointName && { targetEndpointName }),
              },
            });
          },
        publishCatchupEvent:
          (correlationId) => (targetReadModel, event, targetEndpointName) => {
            const log = getLogger('CP/EB/MQE', correlationId);
            log.debug(
              `Publishing catch-up event for ${targetReadModel}: ${JSON.stringify(event)}`,
            );
            mq.emit({
              topic: '__catchup',
              payload: {
                correlationId,
                targetReadModel,
                event,
                ...(targetEndpointName && { targetEndpointName }),
              },
            });
          },
        publishAdminInstruction: (correlationId) => (instruction) => {
          const log = getLogger('CP/EB/MQE', correlationId);
          log.debug(
            `Publishing admin instruction: ${JSON.stringify(instruction)}`,
          );
          mq.emit({
            topic: '__admin',
            payload: { correlationId, instruction },
          });
        },
        subscribeAdminMessages: (handler) => {
          mq.on('__admin', ({ payload }, cb) => {
            handler(payload.correlationId, payload.instruction);
            cb();
          });
          return Promise.resolve();
        },
      }))
      .then((res) => {
        initLog.debug('Message bus ready');
        return res;
      });
  };
