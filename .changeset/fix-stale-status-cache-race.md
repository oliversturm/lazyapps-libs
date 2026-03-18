---
'@lazyapps/readmodels': patch
'@lazyapps/admin-api': patch
'@lazyapps/mqemitter': patch
---

Fix race condition where parallel activation could leave read model status
stuck on "catchup" in the admin dashboard. During parallel activation,
fetchAllStatus() HTTP responses could arrive with stale state data and
overwrite correct SSE-delivered state transitions. Added monotonic
stateVersion counter to status tracker; admin API cache now rejects updates
with a lower stateVersion than the cached entry. Also fixed MQ adminQuery
handler to use statusTracker as single source of truth instead of building
its own status objects.
