---
'@lazyapps/command-sender-fetch': minor
---

Support function-based JWT provider for dynamic token acquisition. The `jwt` option now accepts a function (sync or async) that is called on each `sendCommand` invocation, enabling service-to-service authentication with tokens that are obtained and refreshed dynamically (e.g., Keycloak client credentials flow).
