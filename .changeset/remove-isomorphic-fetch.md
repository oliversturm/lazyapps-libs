---
'@lazyapps/command-sender-fetch': patch
'@lazyapps/change-notification-sender-fetch': patch
---

Remove the unmaintained `isomorphic-fetch` dependency. Node.js 18+ provides native `fetch`; the polyfill is no longer needed.
