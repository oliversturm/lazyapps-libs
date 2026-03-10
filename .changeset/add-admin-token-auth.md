---
'@lazyapps/admin-api': patch
'@lazyapps/bootstrap': patch
'@lazyapps/readmodels': patch
'@lazyapps/mqemitter': patch
'@lazyapps/eventbus-rabbitmq': patch
'@lazyapps/eventbus-mqemitter-redis': patch
---

Add shared-secret token authentication for admin endpoints and event bus messages. Admin HTTP endpoints validate Bearer tokens via app-level middleware. Event bus __admin message handlers validate token field before processing instructions. Auth is optional — when no token is configured, requests pass through for backward compatibility.
