---
'@lazyapps/readmodels': minor
---

Add encryption decryptor integration in projection context and dispatch, enabling transparent decryption of encrypted event fields during read model projection. Automatically trigger crypto-shredding (DEK cache clearing) when SUBJECT_FORGOTTEN events are received, before running projection handlers. Expose forgetSubject in the projection context for manual use.
