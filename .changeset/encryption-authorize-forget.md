---
'@lazyapps/encryption': minor
---

Add optional `authorizeForget` callback to `createEncryption` and `createForgetMixin`. When provided, the callback is invoked with `(aggregate, payload, auth)` before any forget command executes, allowing applications to enforce authorization on forget operations (e.g., only the subject owner or an admin can trigger forget).
