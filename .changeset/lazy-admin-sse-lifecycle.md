---
'@lazyapps/admin-api': minor
'@lazyapps/bootstrap': minor
'@lazyapps/command-processor': patch
'@lazyapps/readmodels': patch
---

Admin SSE subscriptions are now on-demand instead of always-on. The admin
service connects its SSE subscriptions to RM services and the CP when the
first browser attaches or an admin operation starts, and tears them down
again after an idle grace period once the last browser disconnects and no
operation is in progress (configurable via the new `sseIdleGraceMs` admin
config option, default 10s). HTTP endpoints that read the status cache
refresh it on demand via plain HTTP while no SSE is connected. Single-RM
activation is now correctly bracketed as an admin operation, and activate-all
discovers read models even from a cold cache. The command processor's SSE
endpoint now sends a status snapshot to newly connected clients, mirroring
the read-model side, so late-connecting subscribers don't miss transitions.
The read-model catch-up FIFO drain now makes its completion decision inside
the serialized event queue, closing a race where live events still queued
behind the drain's flush marker were projected without deduplication after
the read model went live (duplicating events that had already been projected
during catch-up). The read-model status tracker is now seeded from the
storage-loaded timestamps, so a freshly (re)started service no longer
advertises lastProjectedEventTimestamp 0 over SSE — which made catch-up
orchestration restart from T=0 and re-project already-projected events.
