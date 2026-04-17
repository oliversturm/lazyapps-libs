---
'@lazyapps/express': patch
---

Sanitize MongoDB operator keys (`$`-prefixed), dotted keys, and prototype-pollution keys (`__proto__`, `constructor`, `prototype`) from `req.body` before passing it to read model resolvers. Prevents NoSQL operator injection and prototype pollution via crafted request bodies.
