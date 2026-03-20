---
'@lazyapps/aggregatestore-inmemory': minor
---

Pass aggregateId to the aggregate's `initial()` function, allowing aggregates to include their own id in the initial state. Backwards compatible — existing aggregates with parameterless `initial()` functions are unaffected.
