import { getLogger } from '@lazyapps/logger';
import { metrics } from '@opentelemetry/api';
import { withSpan } from './tracing.js';

const meter = metrics.getMeter('@lazyapps/command-processor');

const commandCounter = meter.createCounter('lazyapps.commands.total', {
  description: 'Total commands processed',
});

// We can receive an external timestamp, in case that gives
// better accuracy. If we don't receive one here, we'll
// record our own as soon as we can.
export const handleCommand = (
  aggregateStore,
  eventStore,
  eventBus,
  command,
  aggregateName,
  aggregateId,
  payload,
  commandHandler,
  auth,
  timestamp = null,
  correlationId,
  commandRecorder = null,
) =>
  withSpan(
    'lazyapps.command.handle',
    {
      'command.name': command,
      'aggregate.name': aggregateName,
      'aggregate.id': aggregateId,
    },
    () =>
      Promise.resolve(timestamp || Date.now())
        .then((timestamp) => {
          // If command recording is enabled, record the command first
          if (commandRecorder) {
            return commandRecorder
              .recordCommand({
                command,
                aggregateName,
                aggregateId,
                payload,
                auth,
                timestamp,
                correlationId,
              })
              .then(() => timestamp);
          }
          return timestamp;
        })
        .then((timestamp) =>
          Promise.resolve(
            aggregateStore.getAggregateState(aggregateName, aggregateId),
          )
            .then((aggregateState) =>
              commandHandler(aggregateState, payload, auth),
            )
            .then((eventMixin) => {
              if (!eventMixin.type)
                throw new Error(
                  `[${correlationId}] Event created for command ${command} on aggregate ${aggregateName}(${aggregateId}) has no 'type'`,
                );
              const event = {
                ...eventMixin,
                timestamp,
                aggregateName,
                aggregateId,
              };
              const log = getLogger('CP/Handler', correlationId);
              log.debug(`Event generated: ${JSON.stringify(event)}`);
              return event;
            })
            .then(eventStore.addEvent(correlationId))
            .then(aggregateStore.applyAggregateProjection(correlationId))
            .then(eventBus.publishEvent(correlationId)),
        )
        .then((result) => {
          commandCounter.add(1, {
            'command.name': command,
            status: 'success',
          });
          return result;
        })
        .catch((err) => {
          commandCounter.add(1, {
            'command.name': command,
            status: 'error',
          });
          throw err;
        }),
  );
