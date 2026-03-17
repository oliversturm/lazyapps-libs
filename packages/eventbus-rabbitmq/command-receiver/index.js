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
    initLog.info(`Message bus connected to Rabbit MQ exchange "${exchange}"`);
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
      publishReplayEvent:
        (correlationId) => (targetReadModel, event, targetEndpointName) => {
          const log = getLogger('CmdProc/EB/Rabbit', correlationId);
          log.debug(`Publishing replay event for ${targetReadModel}`);
          channel.publish(
            exchange,
            '__replay',
            Buffer.from(
              JSON.stringify({
                correlationId,
                targetReadModel,
                event,
                ...(targetEndpointName && { targetEndpointName }),
              }),
            ),
          );
        },
      publishCatchupEvent:
        (correlationId) => (targetReadModel, event, targetEndpointName) => {
          const log = getLogger('CmdProc/EB/Rabbit', correlationId);
          log.debug(`Publishing catch-up event for ${targetReadModel}`);
          channel.publish(
            exchange,
            '__catchup',
            Buffer.from(
              JSON.stringify({
                correlationId,
                targetReadModel,
                event,
                ...(targetEndpointName && { targetEndpointName }),
              }),
            ),
          );
        },
      publishAdminInstruction: (correlationId) => (instruction) => {
        const log = getLogger('CmdProc/EB/Rabbit', correlationId);
        log.debug(
          `Publishing admin instruction: ${JSON.stringify(instruction)}`,
        );
        channel.publish(
          exchange,
          '__admin',
          Buffer.from(JSON.stringify({ correlationId, instruction })),
        );
      },
      subscribeAdminMessages: (handler) =>
        channel.assertQueue('', { exclusive: true }).then((q) =>
          channel.bindQueue(q.queue, exchange, '__admin').then(() =>
            channel.consume(
              q.queue,
              (msg) => {
                const { correlationId, instruction } = JSON.parse(
                  msg.content.toString(),
                );
                handler(correlationId, instruction);
              },
              { noAck: true },
            ),
          ),
        ),
    };
  });
};
