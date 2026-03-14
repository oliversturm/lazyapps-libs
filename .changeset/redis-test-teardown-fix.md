---
'@lazyapps/eventbus-mqemitter-redis': patch
---

Fix flaky integration test teardown: keep the uncaught exception handler registered instead of removing it on a timer, preventing intermittent ECONNREFUSED errors when mqemitter-redis connections outlive the testcontainer.
