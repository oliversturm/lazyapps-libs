---
'@lazyapps/readmodels': patch
---

Pass correlationId to side-effect promise generators via schedule()

Side-effect promise generators scheduled through `schedule()` now receive
`correlationId` as their first argument. This allows side effects to propagate
correlation context to downstream operations (e.g., HTTP calls, logging) without
relying on the projection context object.

This is a backward-compatible change — existing promise generators that ignore
the argument will continue to work.
