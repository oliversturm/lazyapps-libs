---
'@lazyapps/express': minor
'@lazyapps/change-notifier-socket-io': minor
---

Add four hardening parameters to `runExpress`: `corsOrigin`, `bodyLimit`, `helmet`, and `rateLimiter`. The same parameters are accepted by the change-notifier Socket.IO server.

- `corsOrigin` — passed through to `cors()` and Socket.IO's CORS option. **DEFAULT remains the current wildcard (`*`)** for backwards compatibility; this is loudly flagged as unsafe in production in the package README, the JSDoc on the parameter, and an inline source comment. Consumers should set this to a specific origin or array of origins for production deployments.
- `bodyLimit` — passed through to `bodyParser.json({limit})`. Default `'100kb'` (matching the bodyParser default but now explicit and configurable).
- `helmet` — bundled `helmet` middleware integration. When `true`, applied with helmet's defaults; when an object, passed as helmet's options; when `false`/undefined, skipped.
- `rateLimiter` — Express middleware passed by the consumer. When provided, applied via `app.use(rateLimiter)` in the chain. The framework does NOT bundle a specific rate-limiter implementation. The general-purpose `customizeExpress` hook is documented separately in the README as the escape hatch for cases needing multiple limiters or non-standard ordering.

Middleware ordering: `helmet → rateLimiter → bodyParser → cors → routes`, documented inline in the source so the next maintainer doesn't reorder accidentally.
