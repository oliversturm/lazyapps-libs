// Mask credentials (user:password@) in URL strings before logging.
// Leaks of connection strings with embedded credentials are a recurring
// source of incident exposure (#9, #13) — this helper is the single
// place callers should send URLs through before emitting to logs.

export const redactUrl = (value) => {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'string') return value;
  if (value === '') return value;

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return value;
  }

  if (!parsed.username && !parsed.password) return value;

  // Zero out credentials on the parsed URL. Using the standard URL
  // serializer preserves the rest of the URL (query string, hash, path).
  parsed.username = '';
  parsed.password = '';
  // `new URL('mongodb://host/db').toString()` returns 'mongodb://host/db'
  // so we inject the literal '***@' between scheme-end and the host.
  const raw = parsed.toString();
  const schemeEnd = raw.indexOf('://');
  return raw.slice(0, schemeEnd + 3) + '***@' + raw.slice(schemeEnd + 3);
};
