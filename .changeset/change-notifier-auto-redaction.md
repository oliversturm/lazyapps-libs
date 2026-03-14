---
'@lazyapps/change-notifier-socket-io': minor
---

Auto-redact change notification fields based on encryption schema and user JWT scopes. The redaction engine now checks inside `changeInfo.details` (the framework's canonical change notification structure) for fields matching encryption contexts. Changed placeholder format from `{ unauthorized: true }` to `{ restricted: true }` to align with frontend conventions. Added automatic `expressJwtSecret` construction from `jwksUri` when `jwtSecret` is not explicitly provided, eliminating redundant JWT config in applications.
