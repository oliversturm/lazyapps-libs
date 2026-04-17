---
'@lazyapps/logger': minor
---

Complete OTel span correlation in log emission. When the logger is configured with `trace` and `context` APIs and an active span exists, the span's `traceId` and `spanId` are attached to emitted OTel log records as top-level fields (per OTel logs data model), enabling logs-to-traces navigation in observability backends.
