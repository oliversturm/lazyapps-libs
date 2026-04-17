// Strip MongoDB operator tokens (`$`-prefixed keys, keys containing `.`)
// AND prototype-pollution keys (`__proto__`, `constructor`, `prototype`)
// from an arbitrary JSON-shaped value before passing it to a resolver.
// SEC-23: request bodies arrive untrusted from the HTTP layer; a resolver
// that forwards them verbatim into `collection.find(req.body)` is vulnerable
// to NoSQL injection via `$ne`, `$where`, etc., and to prototype pollution
// via JSON-parsed `__proto__` payloads (which produce real own enumerable
// keys, unlike object literals).
//
// Contract:
// - null / undefined pass through unchanged.
// - Primitives pass through unchanged.
// - Objects are shallow-cloned into a NEW object with offending keys removed.
// - Arrays are walked and element-wise cloned (no in-place mutation).
// - Recursion is unconditional: offending keys are stripped at every depth.
// - The result object's prototype chain is the standard `Object.prototype`
//   — we deliberately use `{}` rather than `Object.create(null)` so callers
//   can still use ordinary object semantics on the sanitized payload.

// __proto__ on a plain object literal is an accessor defined on
// Object.prototype, so assigning `out.__proto__ = X` would normally swap the
// prototype chain instead of creating an own property. Same risk class for
// `constructor` and `prototype`. We refuse to copy any of these by name.
const POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const isPlainObject = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  // Exclude things we can't/shouldn't walk: dates, buffers, regex, maps, etc.
  Object.getPrototypeOf(value) === Object.prototype;

const sanitize = (value) => {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(sanitize);
  if (!isPlainObject(value)) return value;

  const out = {};
  // Use Object.keys to iterate own enumerable string keys without invoking
  // accessors. JSON.parse produces own enumerable `__proto__` keys, which
  // Object.keys surfaces — that's exactly what we want to deny.
  for (const key of Object.keys(value)) {
    if (POLLUTION_KEYS.has(key)) continue;
    if (key.startsWith('$')) continue;
    if (key.includes('.')) continue;
    out[key] = sanitize(value[key]);
  }
  return out;
};

export const sanitizeMongoOperators = (value) => sanitize(value);
