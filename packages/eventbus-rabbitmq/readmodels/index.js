import { getLogger } from '@lazyapps/logger';
import { channelWithExchange } from '../channelWithExchange.js';

export const rabbitMq = (config) => (context) => {
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
      context.publishAdminReply = (replyTopic, payload) => {
        channel.publish(
          exchange,
          replyTopic,
          Buffer.from(JSON.stringify(payload)),
        );
      };
      return channel.assertQueue('', { exclusive: true }).then((q) => {
        const bindEvents = () =>
          channel.bindQueue(q.queue, exchange, pattern).then(() => {
            eventsSubscribed = true;
            initLog.debug('Subscribed to events topic');
          });

        const bindSystemTopics = () =>
          channel
            .bindQueue(q.queue, exchange, '__system')
            .then(() => channel.bindQueue(q.queue, exchange, '__replay'))
            .then(() => channel.bindQueue(q.queue, exchange, '__catchup'))
            .then(() => channel.bindQueue(q.queue, exchange, '__admin'));

        const startConsuming = () => {
          initLog.info(
            `Event bus connected to Rabbit MQ exchange "${exchange}" with pattern "${pattern}"`,
          );
          return channel.consume(
            q.queue,
            (msg) => {
              if (msg.fields.routingKey.startsWith('__system')) {
                const { correlationId, event } = JSON.parse(
                  msg.content.toString(),
                );
                const log = getLogger('RM/EB/Rabbit', correlationId);
                log.debug(
                  `Received '__system' event: ${JSON.stringify(event)}`,
                );

                handleSysMessage(event, correlationId);
              } else if (msg.fields.routingKey.startsWith('__replay')) {
                const {
                  correlationId,
                  targetReadModel,
                  event,
                  targetServiceId,
                } = JSON.parse(msg.content.toString());
                const log = getLogger('RM/EB/Rabbit/Replay', correlationId);
                if (
                  targetServiceId &&
                  context.correlationConfig &&
                  targetServiceId !== context.correlationConfig.serviceId
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
                  targetServiceId,
                } = JSON.parse(msg.content.toString());
                const log = getLogger('RM/EB/Rabbit/CatchUp', correlationId);
                if (
                  targetServiceId &&
                  context.correlationConfig &&
                  targetServiceId !== context.correlationConfig.serviceId
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
                  instruction.targetServiceId &&
                  context.correlationConfig &&
                  instruction.targetServiceId !==
                    context.correlationConfig.serviceId
                ) {
                  log.debug(
                    `Ignoring admin instruction for service '${instruction.targetServiceId}'`,
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
                // Ignore other system messages (e.g. __admin_reply)
              } else if (eventsSubscribed) {
                // must assume that this message
                // was caught due to the pattern
                // passed from the outside
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
                  inReplay,
                );
              }
            },
            { noAck: true },
          );
        };

        return (
          context.deferEventsSubscription
            ? bindSystemTopics().then(() => {
                context.subscribeToEvents = () => bindEvents();
                initLog.debug(
                  'Deferred events subscription — waiting for activate()',
                );
              })
            : bindEvents().then(() => bindSystemTopics())
        ).then(() => startConsuming());
      });
    })
    .catch((err) => {
      initLog.error(`Failed to bind queue to Rabbit MQ exchange: ${err}`);
    });
};
