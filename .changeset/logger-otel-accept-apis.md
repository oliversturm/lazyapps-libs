---
'@lazyapps/logger': major
---

BREAKING: configureOtel() now accepts OTEL API objects as a parameter instead of dynamically importing them. Callers must pass `{ logs, SeverityNumber, trace, context }`. This fixes structured logs not being emitted in pnpm strict dependency isolation.
