---
'@lazyapps/observability': minor
---

Default the OTLP transport to TLS (`insecure: false`). Telemetry data is no longer transmitted in plaintext by default; deployments that need plaintext OTLP (e.g., development against a non-TLS collector) must explicitly opt in with `insecure: true`.
