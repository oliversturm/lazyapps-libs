---
'@lazyapps/readmodelstorage-mongodb': minor
---

Add file-based backup system using mongodump/mongorestore (BSON) and mongoexport/mongoimport (JSON). Supports create, list, restore, delete, clear collections, and retention cleanup (maxCount/maxAge). Replaces in-database backup approach with filesystem storage and per-backup metadata.
