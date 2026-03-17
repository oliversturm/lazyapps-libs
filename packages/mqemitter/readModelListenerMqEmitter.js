import { getLogger } from '@lazyapps/logger';
import { getSharedMqEmitter } from './mqEmitterRegistry.js';
import { nanoid } from 'nanoid';
import { trace, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('@lazyapps/mqemitter');

export const readModelListenerMqEmitter =
  ({ mqName }) =>
  (context) => {
    const initLog = getLogger('RM/LS', 'INIT');
    const mq = getSharedMqEmitter('INIT', mqName);

    // Register status change publisher immediately (synchronously)
    // so it's ready before async initialization completes.
    // This prevents a race where the admin activator sends commands
    // before the listener's async setup finishes.
    if (context.statusTracker) {
      context.statusTracker.onStatusChange((statusData) => {
        mq.emit({
          topic: 'adminStatusUpdate',
          payload: statusData,
        });
      });
    }

    return Promise.resolve(mq)
      .then((mq) => {
        mq.on('query', ({ payload }, cb) => {
          const { readModelName, resolverName, args, replyTopic } = payload;
          let { correlationId } = payload;
          if (!correlationId) {
            correlationId = `${
              context.correlationConfig?.serviceId || 'UNK'
            }-${nanoid()}`;
          }

          const log = getLogger('RM/LS', correlationId);
          log.debug(
            `Query received for ${readModelName}/${resolverName} (reply ${replyTopic}) with args ${JSON.stringify(
              args,
            )}`,
          );
          const readModel = context.readModels[readModelName];
          if (!readModel) {
            log.error(
              `Read model ${readModelName} not found during query for ${readModelName}/${resolverName} (reply ${replyTopic}) with args ${JSON.stringify(
                args,
              )}`,
            );
            cb();
            return;
          }
          const resolver = readModel.resolvers[resolverName];
          if (!resolver) {
            log.error(
              `Resolver ${resolverName} not found in read model ${readModelName} during query for ${readModelName}/${resolverName} (reply ${replyTopic}) with args ${JSON.stringify(
                args,
              )}`,
            );
            cb();
            return;
          }

          tracer.startActiveSpan(
            'lazyapps.readmodel.query',
            {
              attributes: {
                'readmodel.name': readModelName,
                'readmodel.resolver': resolverName,
              },
            },
            (span) => {
              Promise.resolve(
                resolver(context.storage.perRequest(correlationId), args),
              )
                .then((result) => {
                  span.end();
                  const payload = {
                    correlationId,
                    result,
                  };
                  mq.emit({ topic: replyTopic, payload });
                })
                .catch((err) => {
                  span.recordException(err);
                  span.setStatus({
                    code: SpanStatusCode.ERROR,
                    message: err.message,
                  });
                  span.end();
                  log.error(
                    `An error occurred handling query for ${readModelName}/${resolverName} (reply ${replyTopic}) with args ${JSON.stringify(
                      args,
                    )}: ${err}`,
                  );
                });
            },
          );

          cb();
        });

        mq.on('adminStatusQuery', ({ payload }, cb) => {
          let { correlationId, replyTopic, endpointName, readModelName } =
            payload;
          if (!correlationId) {
            correlationId = `${
              context.correlationConfig?.serviceId || 'UNK'
            }-${nanoid()}`;
          }

          const log = getLogger('RM/LS', correlationId);
          log.debug(
            `Admin status query for ${endpointName}/${readModelName} (reply ${replyTopic})`,
          );

          const result = context.statusTracker
            ? context.statusTracker.getStatus(readModelName)
            : null;

          mq.emit({
            topic: replyTopic,
            payload: { correlationId, result },
          });

          cb();
        });

        mq.on('adminReplayRelevantEventsQuery', ({ payload }, cb) => {
          let { correlationId, replyTopic, readModelName } = payload;
          if (!correlationId) {
            correlationId = `${
              context.correlationConfig?.serviceId || 'UNK'
            }-${nanoid()}`;
          }

          const log = getLogger('RM/LS', correlationId);
          log.debug(
            `Admin replayRelevantEvents query for ${readModelName} (reply ${replyTopic})`,
          );

          const rm = context.readModels[readModelName];
          const result = rm?.replayRelevantEvents || null;

          mq.emit({
            topic: replyTopic,
            payload: { correlationId, result },
          });

          cb();
        });

        mq.on('adminQuery', ({ payload }, cb) => {
          let { correlationId, replyTopic } = payload;
          if (!correlationId) {
            correlationId = `${
              context.correlationConfig?.serviceId || 'UNK'
            }-${nanoid()}`;
          }

          const log = getLogger('RM/LS', correlationId);
          log.debug(`Admin query received (reply ${replyTopic})`);

          const replayStates =
            context.projectionHandler?.getReadModelReplayStates() || {};

          const result = Object.entries(context.readModels).map(
            ([name, rm]) => ({
              name,
              endpointName: context.endpointName,
              lastProjectedEventTimestamp: rm.lastProjectedEventTimestamp || 0,
              status: replayStates[name] ? 'replaying' : 'active',
              state: context.lifecycleManager?.getState(name),
              fifoQueueSize:
                context.projectionHandler?.getFifoQueueSize?.(name),
            }),
          );

          mq.emit({
            topic: replyTopic,
            payload: { correlationId, result },
          });

          cb();
        });
      })
      .then((res) => {
        initLog.debug(`Read model listener active`);
        return res;
      });
  };
