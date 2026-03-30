---
'@lazyapps/readmodels': minor
'@lazyapps/admin-api': minor
'@lazyapps/admin-ui': minor
'@lazyapps/command-processor': minor
'@lazyapps/bootstrap': minor
---

Lifecycle state refactor and test isolation

- Rename lifecycle state 'stopped' to 'idle', add new 'replay-done' state
  for unambiguous post-replay status
- Add goLive() for dev-mode skip-catchup (idle/replay-done → live)
- Clone readModel definitions in initializeContext to prevent mutation leaks
- Add replayDelayMs option for CP replay throttling
- Simplify replay page UI — no stateVersion tracking needed, states are
  unambiguous
