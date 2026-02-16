---
'@lazyapps/observability': minor
---

Support zero-config initialization via standard OTEL environment variables. Config defaults changed to undefined so the SDK uses OTEL_SERVICE_NAME, OTEL_EXPORTER_OTLP_ENDPOINT, etc. when no explicit config is provided. Added register.js entry point for --import usage, serviceNamespace config for service.namespace resource attribute, and conditional resource/exporter creation (returns undefined when unconfigured). Moved @lazyapps/logger from devDependencies to dependencies.
