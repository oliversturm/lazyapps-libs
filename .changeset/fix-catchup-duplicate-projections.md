---
'@lazyapps/readmodels': patch
---

Fix duplicate projections during catch-up in orchestrated deployments.
statusTracker.lastProjectedEventTimestamp was not updated during live event
projection, causing the admin orchestrator to send fromTimestamp=0 on
re-activation, which re-streamed and re-projected already-projected events.
Also initialize lastCatchupTimestamp from the read model's actual timestamp
instead of 0 for defense-in-depth deduplication.
