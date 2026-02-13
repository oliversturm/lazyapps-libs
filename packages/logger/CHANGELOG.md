# @lazyapps/logger

## 0.2.0

### Minor Changes

- 88341c9: Fix structured logs not reaching OTLP collector. Pass LoggerProvider directly from observability to logger's configureOtel, bypassing the global @opentelemetry/api-logs registry which fails when pnpm resolves duplicate package versions.
- ce159fd: Add configureOtel() function for OTEL log record emission with trace correlation
- b89353d: configureOtel() now accepts OTEL API objects as a parameter instead of dynamically importing them. Callers must pass `{ logs, SeverityNumber, trace, context }`. This fixes structured logs not being emitted in pnpm strict dependency isolation.

## 0.1.1

### Patch Changes

- 4863d93: Remove exports field from all packages to allow direct subpath imports. Add missing express-jwt dependency to change-notifier-socket-io.
