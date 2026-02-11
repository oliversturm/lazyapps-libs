import { trace, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('@lazyapps/command-processor');

export const withSpan = (name, attributes, fn) =>
  tracer.startActiveSpan(name, { attributes }, (span) =>
    Promise.resolve()
      .then(() => fn(span))
      .then((result) => {
        span.end();
        return result;
      })
      .catch((err) => {
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
        span.end();
        throw err;
      }),
  );
