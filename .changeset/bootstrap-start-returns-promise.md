---
'@lazyapps/bootstrap': patch
---

`start()` now returns a promise that settles once every configured subsystem
has finished starting, including the ones brought up via fire-and-forget
dynamic imports (`admin`, `svelte`). Previously it returned nothing, so those
dynamic-import chains could resolve after the caller had moved on — in tests,
after mock teardown, running the real module with a stale config and producing
an unhandled rejection. Callers may now await startup (or ignore the promise,
as before). The bootstrap span still ends synchronously after the kickoff, so
tracing behaviour is unchanged.
