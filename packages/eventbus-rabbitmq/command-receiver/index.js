import { getLogger } from '@lazyapps/logger';
import { channelWithExchange } from '../channelWithExchange.js';

export const rabbitMq = (config) => () => {
  const defaultConfig = {
    url: 'amqp://localhost',
    socketOptions: {},
    exchange: 'events',
    topic: 'events',
  };
  const actualConfig = { ...defaultConfig, ...config };
  const { exchange, topic } = actualConfig;

  const initLog = getLogger('CP/EB/Rabbit', 'INIT');

  return channelWithExchange(actualConfig, initLog).then(({ channel }) => {
    initLog.info(`Event bus connected to Rabbit MQ exchange "${exchange}"`);
    return {
      publishEvent: (correlationId) => (event) => {
        const log = getLogger('CmdProc/EB/Rabbit', correlationId);
        log.debug(`Publishing event timestamp ${event.timestamp}`);
        channel.publish(
          exchange,
          topic,
          Buffer.from(JSON.stringify({ correlationId, event })),
        );
        return event;
      },
      publishReplayState: (correlationId) => (state, readModel) => {
        const log = getLogger('CmdProc/EB/Rabbit', correlationId);
        log.debug(
          `Publishing replay state ${state} for ${readModel || 'global'}`,
        );
        channel.publish(
          exchange,
          '__system',
          Buffer.from(
            JSON.stringify({
              correlationId,
              event: {
                type: 'SET_REPLAY_STATE',
                state,
                ...(readModel && { readModel }),
              },
            }),
          ),
        );
        return state;
      },
      publishReplayEvent: (correlationId) => (targetReadModel, event) => {
        const log = getLogger('CmdProc/EB/Rabbit', correlationId);
        log.debug(`Publishing replay event for ${targetReadModel}`);
        channel.publish(
          exchange,
          '__replay',
          Buffer.from(
            JSON.stringify({ correlationId, targetReadModel, event }),
          ),
        );
      },
      publishSystemMessage: (correlationId) => (message) => {
        const log = getLogger('CmdProc/EB/Rabbit', correlationId);
        log.debug(`Publishing system message: ${JSON.stringify(message)}`);
        channel.publish(
          exchange,
          '__system',
          Buffer.from(JSON.stringify({ correlationId, event: message })),
        );
      },
      subscribeSystemMessages: (handler) =>
        channel
          .assertQueue('', { exclusive: true })
          .then((q) =>
            channel.bindQueue(q.queue, exchange, '__system').then(() =>
              channel.consume(
                q.queue,
                (msg) => {
                  const { event } = JSON.parse(msg.content.toString());
                  handler(event);
                },
                { noAck: true },
              ),
            ),
          ),
    };
  });
};
