---
'@lazyapps/express': minor
'@lazyapps/change-notifier-socket-io': minor
---

Add configurable JWT algorithm and JWKS support for Keycloak/OIDC.

Express and change-notifier-socket-io now accept a `jwtAlgorithms` parameter
(defaults to `['HS256']` for backward compatibility). Socket.io JWT
verification supports async JWKS key resolution via `jwksUri` parameter.
Enables Keycloak and other OIDC providers that use RS256-signed JWTs.
