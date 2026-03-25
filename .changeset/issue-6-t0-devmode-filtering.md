---
'@lazyapps/admin-api': minor
'@lazyapps/admin-ui': minor
'@lazyapps/express': minor
'@lazyapps/readmodels': minor
---

Issue #6 completion: T=0 scenarios, development mode, side-effect filtering

- T=0 production scenarios: three-option dialog for fresh RM replay-from-scratch
  and blank-machine backup restore (replay to current time, skip replay catch-up
  only, custom boundary timestamp)
- Preflight endpoint for T=0 detection on page load
- Reusable TimestampEntry component with dual numeric/UTC input
- Development mode infrastructure: bootstrap flag, per-instruction gatekeeping,
  admin UI indicators (red banner, dev-only controls)
- Dev-mode overrides: dismiss invalid state, activate without catch-up,
  enable side effects during replay, suppress side effects during catch-up
- Side-effect filter parser (regex-based, no eval) with IncludeByName,
  ExcludeByName, IncludeCommand, ExcludeCommand helpers
- Filter application in projection context (ByName wraps schedule, ByCommand
  wraps execute)
- Suppress change notifications during catch-up (issue #10)
- Remove execution modes from sideEffects.schedule (issue #11)
- CP-side lastTimestamp endpoint for event store queries
