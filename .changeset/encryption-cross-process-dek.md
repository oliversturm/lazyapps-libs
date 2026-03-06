---
'@lazyapps/encryption': minor
---

Embed wrapped DEK in encrypted field payloads for cross-process decryption, add plaintext DEK caching in envelope encryption to avoid repeated Vault Transit calls, and track forgotten subjects in all key store implementations to preserve crypto-shredding when wrapped keys are embedded.
