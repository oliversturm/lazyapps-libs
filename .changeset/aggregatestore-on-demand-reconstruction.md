---
'@lazyapps/aggregatestore-inmemory': minor
---

Replace startup aggregate replay with on-demand aggregate reconstruction. Aggregates are now built from events on first access instead of all at startup. getAggregateState and applyAggregateProjection now return Promises. New setEventStoreRef method allows injecting the event store's getEventsForAggregate function. Removed startReplay/endReplay.
