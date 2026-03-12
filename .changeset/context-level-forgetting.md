---
'@lazyapps/encryption': minor
'@lazyapps/bootstrap': minor
'@lazyapps/command-processor': patch
'@lazyapps/readmodels': minor
---

Context-level forgetting: per-context key shredding instead of all-or-nothing.

- Add `forgetSubjectContext(subjectId, contextName)` primitive to encryption API
- Update `forgetSubject` to be config-driven via `autoForget` flag, returns `Promise<string[]>`
- Add `subjects` config parameter to `createEncryption()` with `getSubjects()` accessor
- Add `createForgetMixin` factory for auto-injected forget command handlers and projections
- Bootstrap detects encryption subjects and injects forget mixin into aggregates
- Per-field decryption error handling: forgotten context fields get fallbacks individually
- `shredIfForget` reads `contexts` array from event payload (clean break, no fallback)
- Remove `subjectLifecycleAggregate` and `forgetSubjectEndpoints` (replaced by mixin)
