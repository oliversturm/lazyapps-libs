---
'@lazyapps/command-processor': patch
'@lazyapps/admin-api': patch
'@lazyapps/admin-ui': patch
'@lazyapps/mqemitter': patch
'@lazyapps/eventbus-rabbitmq': patch
'@lazyapps/eventbus-mqemitter-redis': patch
---

Fix replay routing to be service-aware, preventing duplicate projections when multiple services share a read model name. Replay events now include a targetServiceId so that only the intended service processes them. Backward compatible — replays without a targetServiceId behave as before.
