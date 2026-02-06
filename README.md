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
| [@lazyapps/bootstrap](packages/bootstrap) | Composition orchestrator for flexible deployment topologies |

## npm

All packages are published under the [@lazyapps](https://www.npmjs.com/org/lazyapps) org on npm.

## License

ISC
