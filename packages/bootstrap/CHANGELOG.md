# @lazyapps/bootstrap

## 0.2.1

### Patch Changes

- eb79cd1: Republish with updated @lazyapps/readmodels dependency (^0.1.3) to pick up correlationId in side-effect schedule()

## 0.2.0

### Minor Changes

- b89353d: Add signal handling for graceful OTEL SDK shutdown on SIGINT/SIGTERM. Uses dynamic import so observability is optional. Includes 5s force-exit timeout.

### Patch Changes

- Updated dependencies [88341c9]
- Updated dependencies [ce159fd]
- Updated dependencies [b89353d]
  - @lazyapps/logger@0.2.0
  - @lazyapps/command-processor@0.1.2
  - @lazyapps/readmodels@0.1.2

## 0.1.4

### Patch Changes

- 4863d93: Remove exports field from all packages to allow direct subpath imports. Add missing express-jwt dependency to change-notifier-socket-io.
- Updated dependencies [4863d93]
  - @lazyapps/command-processor@0.1.1
  - @lazyapps/logger@0.1.1
  - @lazyapps/readmodels@0.1.1

## 0.1.3

### Patch Changes

- c7b2a3a: Use dynamic import for svelte.js so backend services can use bootstrap without @sveltejs/kit installed

## 0.1.2

### Patch Changes

- 3ee8842: Add allowedHosts pass-through to startSvelteKit for Vite's host validation

## 0.1.1

### Patch Changes

- 80cfd68: Fix startSvelteKit to accept correlationConfig as first argument, matching other start\* functions
