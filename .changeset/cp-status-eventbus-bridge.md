---
'@lazyapps/command-processor': minor
'@lazyapps/mqemitter': minor
---

Deliver Command Processor status to the admin over the in-process message bus
(issue #23). The CP `cpStatusTracker` gains an `onStatusChange` listener hook,
and the mqemitter command receiver re-publishes CP status changes on
`adminCpStatusUpdate` and answers `adminCpStatusQuery`. This lets an in-process
bridge (e.g. a monolith SvelteKit backend) serve CP status as admin SSE without
the command processor running an HTTP server — the CP analog of the existing RM
status bridge. Orchestrated deployments are unaffected (they continue to serve
CP status over HTTP via the express command receiver).
