---
'@lazyapps/readmodels': minor
'@lazyapps/bootstrap': minor
'@lazyapps/admin-api': minor
'@lazyapps/admin-ui': minor
'@lazyapps/command-processor': patch
'@lazyapps/mqemitter': patch
'@lazyapps/eventbus-rabbitmq': patch
'@lazyapps/eventbus-mqemitter-redis': patch
---

Replace misuse of correlationConfig.serviceId as a routing mechanism with proper endpointName/readModelName identifiers. Adds endpointName as a service-level config on the readModels bootstrap structure. Admin API routes now use :endpointName/:readModelName. Fixes catchup handler bug where no service identifier was passed to publishCatchupEvent.
