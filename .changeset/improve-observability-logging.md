---
'@lazyapps/readmodels': patch
'@lazyapps/admin-api': patch
'@lazyapps/bootstrap': patch
'@lazyapps/mqemitter': patch
'@lazyapps/eventbus-rabbitmq': patch
'@lazyapps/eventbus-mqemitter-redis': patch
---

Improve observability across catch-up, replay, and admin operations. Thread actual correlationIds through lifecycle manager state transitions instead of hardcoded 'SYS'. Add missing logging to admin API handlers (stop, reset, activate success paths). Add FIFO drain stats and dedup reporting in catch-up handler. Add debug logging to event bus admin instruction handlers.
