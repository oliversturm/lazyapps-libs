# @lazyapps/express

## 0.1.4

### Patch Changes

- Updated dependencies [88341c9]
- Updated dependencies [ce159fd]
- Updated dependencies [b89353d]
  - @lazyapps/logger@0.2.0

## 0.1.3

### Patch Changes

- 2f615ee: Fix query handler not catching synchronous throws from resolvers. Resolvers that throw before returning a promise (e.g. authorization checks) now correctly return 400/403/500 instead of falling through to Express's default error handler.

## 0.1.2

### Patch Changes

- d8e50ec: Unified error handling across all HTTP endpoints: query handler and admin handler now return 400 for ValidationError and 403 for AuthorizationError, consistent with the command API handler. Switched from instanceof to string-based error name matching to work across process boundaries.

## 0.1.1

### Patch Changes

- 4863d93: Remove exports field from all packages to allow direct subpath imports. Add missing express-jwt dependency to change-notifier-socket-io.
- Updated dependencies [4863d93]
  - @lazyapps/logger@0.1.1
