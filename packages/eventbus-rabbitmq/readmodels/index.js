import { getLogger } from '@lazyapps/logger';
import { channelWithExchange } from '../channelWithExchange.js';

export const rabbitMq = (config) => (context) => {
  const defaultConfig = {
    url: 'amqp://localhost',
    socketOptions: {},
    exchange: 'events',
    pattern: '#',
  };
  const actualConfig = { ...defaultConfig, ...config };
  const { exchange, pattern } = actualConfig;

  const initLog = getLogger('RM/EB/Rabbit', 'INIT');

  let eventsSubscribed = false;

  return channelWithExchange(actualConfig, initLog)
    .then(({ channel }) => {
      return channel.assertQueue('', { exclusive: true }).then((q) => {
        const bindEvents = () =>
          channel.bindQueue(q.queue, exchange, pattern).then(() => {
            eventsSubscribed = true;
            initLog.debug('Subscribed to events topic');
          });

        const bindTopics = () =>
          channel
            .bindQueue(q.queue, exchange, '__replay')
            .then(() => channel.bindQueue(q.queue, exchange, '__catchup'))
            .then(() => channel.bindQueue(q.queue, exchange, '__admin'));

        const startConsuming = () => {
          initLog.info(
            `Message bus connected to Rabbit MQ exchange "${exchange}" with pattern "${pattern}"`,
          );
          return channel.consume(
            q.queue,
            (msg) => {
              if (msg.fields.routingKey.startsWith('__replay')) {
                const {
                  correlationId,
                  targetReadModel,
                  event,
                  targetEndpointName,
                } = JSON.parse(msg.content.toString());
                const log = getLogger('RM/EB/Rabbit/Replay', correlationId);
                if (
                  targetEndpointName &&
                  context.endpointName &&
                  targetEndpointName !== context.endpointName
                ) {
                  return;
                }
                if (context.readModels[targetReadModel]) {
                  log.debug(
                    `Replay event for ${targetReadModel}: ${event.type}`,
                  );
                  context.projectionHandler.projectEventForReadModel(
                    correlationId,
                    targetReadModel,
                  )(event);
                }
              } else if (msg.fields.routingKey.startsWith('__catchup')) {
                const {
                  correlationId,
                  targetReadModel,
                  event,
                  targetEndpointName,
                } = JSON.parse(msg.content.toString());
                const log = getLogger('RM/EB/Rabbit/CatchUp', correlationId);
                if (
                  targetEndpointName &&
                  context.endpointName &&
                  targetEndpointName !== context.endpointName
                ) {
                  return;
                }
                if (context.readModels[targetReadModel]) {
                  log.debug(
                    `Catch-up event for ${targetReadModel}: ${event.type}`,
                  );
                  context.projectionHandler.projectCatchupEventForReadModel(
                    correlationId,
                    targetReadModel,
                  )(event);
                }
              } else if (msg.fields.routingKey === '__admin') {
                const { correlationId, instruction } = JSON.parse(
                  msg.content.toString(),
                );
                const log = getLogger('RM/EB/Rabbit/Admin', correlationId);
                if (
                  context.expectedAdminToken &&
                  instruction.token !== context.expectedAdminToken
                ) {
                  log.warn(
                    `[${correlationId}] Rejected admin instruction: invalid token`,
                  );
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
                  return;
                }
                if (
                  instruction.targetReadModel &&
                  !context.readModels[instruction.targetReadModel]
                ) {
                  log.debug(
                    `Ignoring admin instruction for unknown read model '${instruction.targetReadModel}'`,
                  );
                  return;
                }
                log.debug(
                  `Received admin instruction: ${instruction.type} for ${instruction.targetReadModel || 'all'}`,
                );
                if (context.adminInstructionHandler) {
                  context.adminInstructionHandler(correlationId, instruction);
                }
              } else if (msg.fields.routingKey.startsWith('__')) {
                // Ignore other system messages
              } else if (eventsSubscribed) {
                const { correlationId, event } = JSON.parse(
                  msg.content.toString(),
                );
                const log = getLogger('RM/EB/Rabbit', correlationId);
                log.debug(
                  `Received message on topic '${
                    msg.fields.routingKey
                  }': ${JSON.stringify(event)}`,
                );
                context.projectionHandler.projectEvent(correlationId)(
                  event,
                  false,
                );
              }
            },
            { noAck: true },
          );
        };

        return (
          context.deferEventsSubscription
            ? bindTopics().then(() => {
                context.subscribeToEvents = () => bindEvents();
                initLog.debug(
                  'Deferred events subscription — waiting for activate()',
                );
              })
            : bindEvents().then(() => bindTopics())
        ).then(() => startConsuming());
      });
    })
    .catch((err) => {
      initLog.error(`Failed to bind queue to Rabbit MQ exchange: ${err}`);
    });
};
