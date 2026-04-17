---
'@lazyapps/encryption': patch
---

Distinguish decryption failures from genuine forgetting. Decryption errors for non-forgotten subjects now produce a distinct `{decryptionFailed: true, text: '[ENCRYPTED — DECRYPTION FAILED]'}` marker, emit verbose ERROR logs (without plaintext or ciphertext), and increment a new OTel counter `lazyapps.encryption.decryption.events` (with `result` ∈ `success`/`forgotten`/`failed`). Crypto-shredding behavior is preserved: forgotten subjects continue to receive the existing silent `{forgotten: true, text}` fallback. Adds `@opentelemetry/api` as a dependency.
