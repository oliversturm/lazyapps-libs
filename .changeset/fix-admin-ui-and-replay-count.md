---
'@lazyapps/bootstrap': patch
'@lazyapps/command-processor': patch
---

Fix admin UI failing in monolith mode by auto-setting ADMIN_READ_MODEL_SERVICES and ADMIN_COMMAND_PROCESSOR_URL env vars at bootstrap when not externally configured. Fix replay completion discarding event counters by preserving eventsPublished, eventsTotal, and startedAt across terminal state transitions.
