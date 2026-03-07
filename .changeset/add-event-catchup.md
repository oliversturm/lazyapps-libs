---
'@lazyapps/readmodels': minor
'@lazyapps/command-processor': minor
'@lazyapps/admin-api': minor
'@lazyapps/bootstrap': minor
'@lazyapps/mqemitter': minor
'@lazyapps/eventbus-rabbitmq': minor
'@lazyapps/eventbus-mqemitter-redis': minor
---

Add event catch-up system with coordinated activation. Read models start in a waiting state and activate on demand, deferring event bus subscription until first activation. Catch-up streams missed events from the event store with FIFO queue and two-layer deduplication. Includes lifecycle manager, auto-activation with exponential backoff, and admin API endpoints for activate/stop/status.
