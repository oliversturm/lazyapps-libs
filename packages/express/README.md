# @lazyapps/express

Express HTTP bindings for LazyApps. Provides HTTP command receiver endpoints, read model query endpoints, and change notification listener functionality.

## Installation

```bash
pnpm add @lazyapps/express
```

## Hardening parameters

`runExpress({...})` accepts the following hardening parameters in addition to
the auth/JWT/JWKS options. All are optional but production deployments should
review each.

### `corsOrigin`

> ⚠️ **SECURITY WARNING — the default is wildcard CORS (`*`).** Any origin can
> call this server unless you set `corsOrigin` explicitly. This is unsafe in
> production. Always set an explicit allow-list before deploying:
>
> ```js
> runExpress({ corsOrigin: ['https://app.example.com'] })
> ```

Value is forwarded to `cors({origin: ...})`. Accepts the same shapes as the
[`cors` package](https://www.npmjs.com/package/cors): `string`, `string[]`,
`RegExp`, `boolean`, or a function.

### `bodyLimit`

Maximum JSON body size per request. Forwarded to `bodyParser.json({limit})`.
Default `'100kb'`. Accepts strings (`'1mb'`, `'500kb'`) or numbers (bytes).
Requests exceeding the limit are rejected with HTTP 413.

### `helmet`

Adds HTTP security headers via [`helmet`](https://www.npmjs.com/package/helmet).

- `true` → enables helmet with its defaults.
- An object → passed through as helmet options
  (e.g. `{contentSecurityPolicy: false}`).
- Falsy/undefined → helmet is not installed.

### `rateLimiter`

An Express-style middleware `(req, res, next) => ...` applied early in the
chain. Bring-your-own — for example
[`express-rate-limit`](https://www.npmjs.com/package/express-rate-limit):

```js
import rateLimit from 'express-rate-limit';

runExpress({
  rateLimiter: rateLimit({ windowMs: 60_000, max: 100 }),
});
```

`@lazyapps/express` does not bundle a specific limiter implementation so you
can pick whichever fits your deployment (memory, Redis-backed, etc.).

For more complex setups (multiple limiters, per-route limiters, conditional
ordering), use `customizeExpress` instead.

### `customizeExpress`

`(context, app) => void` escape hatch invoked AFTER `installHandlers`. Use for
arbitrary Express customisation that does not fit the dedicated parameters —
for example mounting multiple rate limiters, attaching extra logging middleware,
or installing custom error handlers.

### Middleware ordering

The framework installs middleware in this order, which is intentional and
security-relevant:

```
helmet → rateLimiter → bodyParser → cors → correlationId → morgan → cookieParser → jwt → routes
```

`helmet` first so all responses (including errors) carry security headers.
`rateLimiter` before `bodyParser` so DoS-style oversize bodies are dropped
before being parsed.

## Part of LazyApps

This package is part of the [LazyApps](https://github.com/oliversturm/lazyapps-libs) event-sourcing and CQRS framework.
