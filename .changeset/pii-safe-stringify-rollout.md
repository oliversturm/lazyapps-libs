---
'@lazyapps/express': patch
'@lazyapps/readmodelstorage-mongodb': patch
'@lazyapps/change-notifier-socket-io': patch
'@lazyapps/readmodels': patch
'@lazyapps/aggregatestore-inmemory': patch
'@lazyapps/mqemitter': patch
---

Use `safeStringify` instead of `JSON.stringify` for log statements that include payload-shape data (request bodies, event payloads, decoded JWTs, change notifications, storage operations, queries, commands). Honors the existing PII path configuration to redact sensitive fields.
