---
'@lazyapps/express': patch
---

Unified error handling across all HTTP endpoints: query handler and admin handler now return 400 for ValidationError and 403 for AuthorizationError, consistent with the command API handler. Switched from instanceof to string-based error name matching to work across process boundaries.
