---
'@lazyapps/bootstrap': patch
'@lazyapps/admin-api': patch
'@lazyapps/command-processor': patch
'@lazyapps/mqemitter': patch
'@lazyapps/eventbus-rabbitmq': patch
'@lazyapps/eventbus-mqemitter-redis': patch
'@lazyapps/readmodels': patch
---

Replace HTTP-based admin communication with event bus messages for topology-agnostic inter-service communication. Remove duplicate catch-up handling from admin service — start_catchup and cancel_catchup are now handled exclusively by the command processor.
