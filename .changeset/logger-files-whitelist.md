---
'@lazyapps/logger': patch
---

Fix the `files` whitelist in `package.json` to publish all root `.js` modules via the `*.js` glob. The previous whitelist pinned only `index.js`, which excluded the newly-added `redactUrl.js` from the published tarball and broke consumers that imported the re-exported `redactUrl`.
