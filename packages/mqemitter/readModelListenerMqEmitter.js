import { getLogger, safeStringify } from '@lazyapps/logger';
import { getSharedMqEmitter } from './mqEmitterRegistry.js';
import { nanoid } from 'nanoid';
import { trace, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('@lazyapps/mqemitter');

export const readModelListenerMqEmitter =
  ({ mqName }) =>
  (context) => {
    const initLog = getLogger('RM/LS', 'INIT');
    return Promise.resolve(getSharedMqEmitter('INIT', mqName))
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
            `Query received for ${readModelName}/${resolverName} (reply ${replyTopic}) with args ${safeStringify(
              args,
            )}`,
          );
          const readModel = context.readModels[readModelName];
          if (!readModel) {
            log.error(
              `Read model ${readModelName} not found during query for ${readModelName}/${resolverName} (reply ${replyTopic}) with args ${safeStringify(
                args,
              )}`,
            );
            cb();
            return;
          }
          const resolver = readModel.resolvers[resolverName];
          if (!resolver) {
            log.error(
              `Resolver ${resolverName} not found in read model ${readModelName} during query for ${readModelName}/${resolverName} (reply ${replyTopic}) with args ${safeStringify(
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
                    `An error occurred handling query for ${readModelName}/${resolverName} (reply ${replyTopic}) with args ${safeStringify(
                      args,
                    )}: ${err}`,
                  );
                });
            },
          );

          cb();
        });
      })
      .then((res) => {
        initLog.debug(`Read model listener active`);
        return res;
      });
  };
