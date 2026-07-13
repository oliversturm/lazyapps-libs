---
'@lazyapps/command-processor': minor
'@lazyapps/admin-ui': minor
'@lazyapps/admin-api': patch
---

The command processor's resting status is now reported as `live` instead of
`idle` (issue #15). The CP is always running and accepting commands, so `idle`
read as "broken/not running" on the dashboard; `replaying`/`catching-up` remain
the transient busy states. The admin status cache uses a distinct `unknown`
placeholder before the CP has reported (and marks the CP `unknown` when a status
fetch fails), so a green `live` badge always means the CP was actually reached.

The CP status payload also gains live-detail fields — `startedAt`,
`commandsProcessed`, `eventsWritten`, `lastCommandAt`, `lastEventTimestamp`, and
a bounded `recentReplays` trailing summary — surfaced in the admin dashboard's
Command Processor card so an operator can confirm health without catching the
status badge mid-operation. Counters are advanced transport-agnostically via the
event-publish path; in this framework one command produces exactly one event, so
`commandsProcessed` and `eventsWritten` coincide (both count successfully
processed commands). The admin UI also fixes the `catching-up` badge colour
(previously rendered gray instead of yellow).
