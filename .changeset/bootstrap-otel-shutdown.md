---
'@lazyapps/bootstrap': patch
---

Fix process not exiting on SIGINT/SIGTERM when OTEL SDK is active. Signal handler now gracefully shuts down the OTEL SDK and includes a 5s force-exit timeout.
