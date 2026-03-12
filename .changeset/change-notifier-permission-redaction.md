---
'@lazyapps/change-notifier-socket-io': minor
---

Add permission-scoped sub-rooms and schema-driven redaction for change notifications. Clients are grouped into rooms by their JWT-derived encryption scopes. When emitting notifications, payloads are automatically redacted per scope group using the encryption schema, replacing unauthorized fields with structured placeholder objects. Supports custom per-read-model redaction hooks. Backward-compatible: without encryption config, falls back to original broadcast behavior.
