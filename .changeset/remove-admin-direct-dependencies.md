---
'@lazyapps/admin-api': minor
'@lazyapps/bootstrap': minor
'@lazyapps/command-processor': minor
'@lazyapps/readmodels': minor
---

Remove all direct MongoDB access from admin service — admin now delegates exclusively via event bus.

Bootstrap admin config no longer accepts eventStore, readModelStorage, or backup parameters; admin only requires eventBus and readModels. Replay start/cancel is delegated to the command processor via publishAdminInstruction. Backup create/list/delete and prepare-for-replay are delegated to individual read model services via event bus. Each RM service handles its own backup operations locally.

Breaking: deleteBackupHandler now requires readModelName query parameter to identify the target RM service.
