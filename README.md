# LazyApps Libraries

An event-sourcing and CQRS (Command Query Responsibility Segregation) framework for Node.js applications. LazyApps provides a pluggable architecture where each concern — command processing, event storage, event distribution, read model projection, and change notification — can be implemented with different backing technologies, enabling flexible deployment topologies from monolith to fully distributed.

## Packages

| Package | Description |
| ------- | ----------- |
| [@lazyapps/logger](packages/logger) | Centralized logging with correlation IDs |
| [@lazyapps/log-highlight](packages/log-highlight) | Log output formatting and syntax highlighting |
| [@lazyapps/aggregatestore-inmemory](packages/aggregatestore-inmemory) | In-memory aggregate state cache |
| [@lazyapps/command-processor](packages/command-processor) | Transport-agnostic command validation and aggregate execution |
| [@lazyapps/readmodels](packages/readmodels) | Event projection and query resolution |
| [@lazyapps/eventstore-mongodb](packages/eventstore-mongodb) | MongoDB-backed persistent event store |
| [@lazyapps/readmodelstorage-mongodb](packages/readmodelstorage-mongodb) | MongoDB-backed read model storage |
| [@lazyapps/mqemitter](packages/mqemitter) | In-process message queue with role-specific sub-modules |
| [@lazyapps/express](packages/express) | Express HTTP bindings for commands, queries, and notifications |
| [@lazyapps/eventbus-rabbitmq](packages/eventbus-rabbitmq) | RabbitMQ-based distributed event bus |
| [@lazyapps/eventbus-mqemitter-redis](packages/eventbus-mqemitter-redis) | MQEmitter-based event bus with Redis backing |
| [@lazyapps/change-notification-sender-fetch](packages/change-notification-sender-fetch) | HTTP-based change notification sender |
| [@lazyapps/change-notifier-socket-io](packages/change-notifier-socket-io) | Socket.io-based change notification broadcaster |
| [@lazyapps/command-sender-fetch](packages/command-sender-fetch) | HTTP-based command sender |
| [@lazyapps/command-replay](packages/command-replay) | CLI tool to replay recorded commands |
| [@lazyapps/observability](packages/observability) | OpenTelemetry SDK initialization with auto-instrumentation |
| [@lazyapps/bootstrap](packages/bootstrap) | Composition orchestrator for flexible deployment topologies |

## Observability

LazyApps includes built-in OpenTelemetry support for traces, metrics, and structured logs. The `@lazyapps/observability` package provides SDK initialization with auto-instrumentation for HTTP, Express, MongoDB, AMQP, and Socket.io.

### Enabling observability

Observability is enabled via Node's `--import` flag so that instrumentation hooks are registered before any application modules load:

```bash
node --import @lazyapps/observability/register.js index.js
```

Configuration is driven by standard OTEL environment variables — no init file needed:

| Variable | Example | Purpose |
|----------|---------|---------|
| `OTEL_SERVICE_NAME` | `my-service` | Identifies the service in traces and logs |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4317` | OTLP collector endpoint |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `grpc` | Transport protocol (`grpc` or `http/protobuf`) |
| `OTEL_EXPORTER_OTLP_HEADERS` | `Authorization=Bearer tok` | Auth headers for the collector |
| `OTEL_RESOURCE_ATTRIBUTES` | `service.namespace=myapp,deployment.environment.name=production` | Additional resource attributes |

When no endpoint is set, the SDK starts with instrumentation active but no exporters — useful for local development without a collector.

For cases that need programmatic configuration (e.g. request filtering), you can still call `initialize()` directly from a custom init file:

### What gets instrumented

- **Traces**: HTTP requests, Express routes, MongoDB queries, AMQP messages, Socket.io events, command processing, read model projections, and mqemitter query resolution all produce spans automatically
- **Metrics**: Standard OTEL runtime and HTTP metrics
- **Structured logs**: `@lazyapps/logger` emits log records with trace correlation when configured with OTEL APIs
- **Signal handling**: Bootstrap installs SIGINT/SIGTERM handlers that gracefully flush the OTEL SDK before process exit

### Filtering noisy requests

In development, Vite's HMR traffic can flood traces. Use a custom init file that passes `httpInstrumentation` to filter these out:

```javascript
import { initialize } from '@lazyapps/observability';

initialize({
  httpInstrumentation: {
    ignoreIncomingRequestHook: (request) => {
      const url = request.url || '';
      return url.startsWith('/@') || url.includes('__vite');
    },
  },
});
```

## npm

All packages are published under the [@lazyapps](https://www.npmjs.com/org/lazyapps) org on npm.

## License

ISC
