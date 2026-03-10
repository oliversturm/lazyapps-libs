---
'@lazyapps/bootstrap': patch
'@lazyapps/admin-api': patch
'@lazyapps/command-processor': patch
'@lazyapps/mqemitter': patch
'@lazyapps/eventbus-rabbitmq': patch
'@lazyapps/eventbus-mqemitter-redis': patch
'@lazyapps/readmodels': patch
---

Replace HTTP-based admin communication with event bus messages for topology-agnostic inter-service communication
