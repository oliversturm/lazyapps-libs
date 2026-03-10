---
'@lazyapps/eventstore-mongodb': minor
---

Add getEventsForAggregate() method to retrieve all events for a specific aggregate, sorted by timestamp. Used for on-demand aggregate reconstruction after subject forgetting.
