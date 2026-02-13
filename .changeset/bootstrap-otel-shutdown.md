---
'@lazyapps/bootstrap': minor
---

Add signal handling for graceful OTEL SDK shutdown on SIGINT/SIGTERM. Uses dynamic import so observability is optional. Includes 5s force-exit timeout.
