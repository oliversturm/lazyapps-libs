---
'@lazyapps/express': patch
'@lazyapps/command-processor': patch
---

Add command processor readiness gate. CP starts with ready=false when deferReady is configured, returning HTTP 503 until the admin service signals ready after read model activation completes. Adds POST/GET /admin/ready endpoints on the command receiver.
