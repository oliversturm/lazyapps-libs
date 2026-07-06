---
'@lazyapps/admin-api': minor
'@lazyapps/bootstrap': minor
---

The admin service's browser-facing SSE stream (`/admin/events`) now writes a
periodic heartbeat comment and treats a write failure or response error as a
disconnect. Previously the browser-client refcount was released only when
Express emitted `'close'`, so a browser connection that died without a clean
TCP close (network drop, sleeping laptop) could pin the refcount above zero
and hold the upstream SSE subscriptions to the RM and CP services open
indefinitely. The heartbeat forces writes on the socket so a dead peer
surfaces as an error, releasing the refcount and allowing the idle teardown
to proceed. The interval is configurable via the new `sseHeartbeatMs` admin
config option (default 15s).
