# @lazyapps/observability

## 0.3.0

### Minor Changes

- 1eb3e44: Support zero-config initialization via standard OTEL environment variables. Config defaults changed to undefined so the SDK uses OTEL_SERVICE_NAME, OTEL_EXPORTER_OTLP_ENDPOINT, etc. when no explicit config is provided. Added register.js entry point for --import usage, serviceNamespace config for service.namespace resource attribute, and conditional resource/exporter creation (returns undefined when unconfigured). Moved @lazyapps/logger from devDependencies to dependencies.

## 0.2.0

### Minor Changes

- 88341c9: Fix structured logs not reaching OTLP collector. Pass LoggerProvider directly from observability to logger's configureOtel, bypassing the global @opentelemetry/api-logs registry which fails when pnpm resolves duplicate package versions.
- 8fc3150: Add httpInstrumentation config option to pass options (e.g. ignoreIncomingRequestHook) through to HttpInstrumentation for dev server noise filtering
- ce159fd: Add double-initialization guard to prevent multiple SDK instances when both --import and bootstrap config are used
- b89353d: Add shutdown() export for graceful OTEL SDK teardown during process signal handling
