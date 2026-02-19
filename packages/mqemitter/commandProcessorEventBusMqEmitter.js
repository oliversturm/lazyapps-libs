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
        publishReplayState: (correlationId) => (state, readModel) => {
          const log = getLogger('CP/EB/MQE', correlationId);
          log.debug(
            `Publishing replay state ${state} for ${readModel || 'global'}`,
          );
          mq.emit({
            topic: '__system',
            payload: {
              correlationId,
              event: {
                type: 'SET_REPLAY_STATE',
                state,
                ...(readModel && { readModel }),
              },
            },
          });
          return state;
        },
        publishReplayEvent: (correlationId) => (targetReadModel, event) => {
          const log = getLogger('CP/EB/MQE', correlationId);
          log.debug(`Publishing replay event for ${targetReadModel}`);
          mq.emit({
            topic: '__replay',
            payload: { correlationId, targetReadModel, event },
          });
        },
        publishSystemMessage: (correlationId) => (message) => {
          const log = getLogger('CP/EB/MQE', correlationId);
          log.debug(`Publishing system message: ${JSON.stringify(message)}`);
          mq.emit({
            topic: '__system',
            payload: { correlationId, event: message },
          });
        },
      }))
      .then((res) => {
        initLog.debug('Event bus ready');
        return res;
      });
  };
