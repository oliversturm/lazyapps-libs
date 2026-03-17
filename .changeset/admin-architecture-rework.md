---
'@lazyapps/readmodels': major
'@lazyapps/command-processor': major
'@lazyapps/express': major
'@lazyapps/mqemitter': major
'@lazyapps/eventbus-rabbitmq': major
'@lazyapps/eventbus-mqemitter-redis': major
'@lazyapps/eventstore-mongodb': major
---

Admin architecture rework: SSE-based status monitoring replaces __system topic
and delegateToRm request-reply pattern. RM projection state machine consolidated
to four states (stopped/live/replay/catchup). Admin API orchestrates replay and
catch-up flows via fire-and-forget commands on __admin topic. CP and RM expose
SSE and status HTTP endpoints. set_ready/deferReady, commandReplayState, and
SET_REPLAY_STATE eliminated. All command types use camelCase. replayRelevantEvents
filtering added for replay and catch-up. URL convention: singular nouns,
endpointName and readModelName as path segments.
