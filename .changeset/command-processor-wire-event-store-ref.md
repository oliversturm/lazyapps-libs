---
'@lazyapps/command-processor': patch
---

Wire event store's getEventsForAggregate into aggregate store during context initialization for on-demand reconstruction. Remove startup aggregate replay from context initialization.
