---
'@lazyapps/bootstrap': minor
---

Add optional encryption support to start() configuration. When provided, transparently wraps event store, event bus, and read model storage with field-level encryption. Passes encryptionQueryDecryptor through to read model configuration for transparent query result decryption.
