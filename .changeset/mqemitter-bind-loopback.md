---
'@lazyapps/mqemitter': patch
---

`registerSharedMqEmitter` now binds the shared TCP server to `127.0.0.1` instead of all interfaces, preventing unauthenticated remote access to the in-process message bus.
