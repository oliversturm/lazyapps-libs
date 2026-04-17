---
'@lazyapps/eventbus-rabbitmq': patch
---

Wrap RabbitMQ message `JSON.parse` in try/catch. Malformed messages are logged and dropped instead of crashing the consumer process.
