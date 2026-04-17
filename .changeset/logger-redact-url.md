---
'@lazyapps/logger': minor
'@lazyapps/eventstore-mongodb': patch
'@lazyapps/readmodelstorage-mongodb': patch
'@lazyapps/eventbus-rabbitmq': patch
---

Add `redactUrl(urlStr)` helper that masks credentials in connection URLs (`user:pass@host` becomes `***@host`). Applied at MongoDB and RabbitMQ connection URL log sites to prevent credential leakage.
