---
'@lazyapps/readmodelstorage-mongodb': minor
---

Add configurable backup commands and tool backup path. The backup factory
now accepts mongodumpCommand, mongorestoreCommand, mongoexportCommand,
mongoimportCommand (each an array, defaulting to the tool name), and
toolBackupPath (for when backup tools run in a container with a different
filesystem view). This enables running backups via docker exec or custom
scripts without modifying the library.
