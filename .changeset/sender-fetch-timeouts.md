---
'@lazyapps/command-sender-fetch': minor
'@lazyapps/change-notification-sender-fetch': minor
---

Add a configurable `fetchTimeoutMs` parameter (default 5000ms) to both sender packages. Each `fetch()` call now passes `signal: AbortSignal.timeout(fetchTimeoutMs)`, so a slow downstream service can no longer hold the caller's connection open indefinitely.
