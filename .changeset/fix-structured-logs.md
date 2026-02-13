---
'@lazyapps/observability': minor
'@lazyapps/logger': minor
---

Fix structured logs not reaching OTLP collector. Pass LoggerProvider directly from observability to logger's configureOtel, bypassing the global @opentelemetry/api-logs registry which fails when pnpm resolves duplicate package versions.
