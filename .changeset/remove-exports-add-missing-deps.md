---
'@lazyapps/aggregatestore-inmemory': patch
'@lazyapps/bootstrap': patch
'@lazyapps/change-notification-sender-fetch': patch
'@lazyapps/change-notifier-socket-io': patch
'@lazyapps/command-processor': patch
'@lazyapps/command-replay': patch
'@lazyapps/command-sender-fetch': patch
'@lazyapps/eventbus-mqemitter-redis': patch
'@lazyapps/eventbus-rabbitmq': patch
'@lazyapps/eventstore-mongodb': patch
'@lazyapps/express': patch
'@lazyapps/log-highlight': patch
'@lazyapps/logger': patch
'@lazyapps/mqemitter': patch
'@lazyapps/readmodels': patch
'@lazyapps/readmodelstorage-mongodb': patch
---

Remove exports field from all packages to allow direct subpath imports. Add missing express-jwt dependency to change-notifier-socket-io.
