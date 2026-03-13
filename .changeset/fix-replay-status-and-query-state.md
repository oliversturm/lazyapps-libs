---
'@lazyapps/admin-api': patch
'@lazyapps/bootstrap': patch
'@lazyapps/readmodels': patch
'@lazyapps/mqemitter': patch
---

fix: dynamic read model discovery, remove static stubs and collections from admin service

- Admin service discovers read models dynamically via readModelServiceUrl instead of static stubs
- Handler code split into RM-service (sync) and admin-service (activator proxy) variants
- Removed collections field and detectSharedCollections (storage is an implementation detail)
- Activator caches discovered read models; only created when readModelServiceUrl is provided
- autoActivate without explicit RM list discovers then activates all
- mqemitter adminQuery handler includes serviceId in response
- replay/catchup status returns 'completed' instead of 'idle' after done
- query_state uses HTTP instead of event bus reads
