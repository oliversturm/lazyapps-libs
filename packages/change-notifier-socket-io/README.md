# @lazyapps/change-notifier-socket-io

Socket.io-based change notification broadcaster. Pushes real-time read model change notifications to connected clients via WebSockets.

## Installation

```bash
pnpm add @lazyapps/change-notifier-socket-io
```

## Hardening parameters

`runExpress(correlationConfig, opts)` accepts these hardening parameters in
addition to the auth/JWT/JWKS options. All are optional but production
deployments should review each.

### `corsOrigin`

> ⚠️ **SECURITY WARNING — the default is wildcard CORS (`*`)** for both the
> Express HTTP server and Socket.io. Any origin can connect unless you set
> `corsOrigin` explicitly. This is unsafe in production. Always set an
> explicit allow-list before deploying:
>
> ```js
> runExpress(correlationConfig, {
>   corsOrigin: ['https://app.example.com'],
> });
> ```

Forwarded to both `cors({origin: ...})` and Socket.io's `cors` option.

### `bodyLimit`

Maximum JSON body size for `/change` POSTs. Default `'100kb'`. Forwarded to
`bodyParser.json({limit})`.

### `helmet`

Adds HTTP security headers via [`helmet`](https://www.npmjs.com/package/helmet).
`true` enables defaults; an object passes through as helmet options.

### `rateLimiter`

Express-style middleware `(req, res, next) => ...` applied between `helmet`
and `bodyParser`. Bring your own (e.g. `express-rate-limit`).

### Middleware ordering

```
helmet → rateLimiter → bodyParser → cors → correlationId → morgan → cookieParser → jwt → routes
```

## Part of LazyApps

This package is part of the [LazyApps](https://github.com/oliversturm/lazyapps-libs) event-sourcing and CQRS framework.
