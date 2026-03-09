---
'@lazyapps/encryption': minor
---

Embed wrapped DEK in encrypted field payloads for cross-process decryption, add plaintext DEK caching in envelope encryption to avoid repeated Vault Transit calls, track forgotten subjects in all key store implementations to preserve crypto-shredding when wrapped keys are embedded, and gracefully skip encryption for forgotten subjects in storage encryption to prevent crashes during replay.
