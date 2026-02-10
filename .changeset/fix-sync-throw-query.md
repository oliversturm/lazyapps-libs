---
'@lazyapps/express': patch
---

Fix query handler not catching synchronous throws from resolvers. Resolvers that throw before returning a promise (e.g. authorization checks) now correctly return 400/403/500 instead of falling through to Express's default error handler.
