# @lazyapps/readmodels

## 0.1.3

### Patch Changes

- e95abf0: Pass correlationId to side-effect promise generators via schedule()

  Side-effect promise generators scheduled through `schedule()` now receive
  `correlationId` as their first argument. This allows side effects to propagate
  correlation context to downstream operations (e.g., HTTP calls, logging) without
  relying on the projection context object.

  This is a backward-compatible change — existing promise generators that ignore
  the argument will continue to work.

## 0.1.2

### Patch Changes

- Updated dependencies [88341c9]
- Updated dependencies [ce159fd]
- Updated dependencies [b89353d]
  - @lazyapps/logger@0.2.0

## 0.1.1

### Patch Changes

- 4863d93: Remove exports field from all packages to allow direct subpath imports. Add missing express-jwt dependency to change-notifier-socket-io.
- Updated dependencies [4863d93]
  - @lazyapps/logger@0.1.1
