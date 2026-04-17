---
'@lazyapps/express': patch
---

Send a single response from the admin handler invalid-command path. Previously `res.sendStatus(400).send(...)` produced a "headers already sent" error.
