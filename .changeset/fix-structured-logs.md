---
'@lazyapps/observability': minor
---

Register LoggerProvider globally so structured logs reach the OTLP collector. NodeSDK does not register its internal LoggerProvider with the global api-logs, causing logs.getLogger() to return a NOOP logger that silently discards all log records. The fix creates a LoggerProvider manually and registers it via logs.setGlobalLoggerProvider().
