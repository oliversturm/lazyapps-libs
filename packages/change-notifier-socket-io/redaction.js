// Extract encryption scopes from a decoded JWT token.
// The scopeMapper function transforms the token into a sorted array of scope strings.
// Default: extracts token.scopes or token.encryption_scopes, or returns [].
export const defaultScopeMapper = (decodedToken) => {
  if (!decodedToken) return [];
  const scopes =
    decodedToken.scopes ||
    decodedToken.encryption_scopes ||
    decodedToken.roles ||
    [];
  return Array.isArray(scopes) ? [...scopes].sort() : [];
};

// Build a scope-qualified room name from the base room name and sorted scopes.
export const getScopedRoomName = (baseRoom, scopes) => {
  const scopeKey =
    scopes.length > 0 ? `scopes=${scopes.join(',')}` : 'scopes=none';
  return `${baseRoom}:${scopeKey}`;
};

// Build a scope key string from a sorted array of scopes.
export const getScopeKey = (scopes) =>
  scopes.length > 0 ? scopes.join(',') : 'none';

// Given an encryption schema (from defineEncryptionSchema) and encryption contexts,
// determine which fields in a changeInfo payload should be redacted for a given set of scopes.
// Returns a new payload with unauthorized fields replaced by structured placeholders.
export const redactPayload = (changeInfo, schema, contexts, scopes) => {
  if (!schema || !contexts) return changeInfo;

  const result = { ...changeInfo };

  // Find all field paths in the schema that map to contexts
  // We need to check if any events reference fields that appear in the changeInfo
  // The changeInfo payload may contain resolved data with field names matching context-protected fields
  const scopeSet = new Set(scopes);

  for (const [contextName, contextConfig] of Object.entries(contexts)) {
    if (!contextConfig.roles) continue;

    const isAuthorized = contextConfig.roles.some((r) => scopeSet.has(r));
    if (isAuthorized) continue;

    // This context is not authorized — redact fields belonging to it
    if (contextConfig.fields) {
      for (const fieldName of Object.keys(contextConfig.fields)) {
        if (result[fieldName] !== undefined) {
          const text = schema.getUnauthorizedText(fieldName, contextName);
          result[fieldName] = { unauthorized: true, text };
        }
      }
    }
  }

  // Also check for encrypted field markers in the payload itself
  for (const [fieldName, fieldValue] of Object.entries(result)) {
    if (fieldValue && fieldValue.__encrypted) {
      const contextName = fieldValue.ctx;
      const contextConfig = contexts[contextName];
      if (contextConfig && contextConfig.roles) {
        const isAuthorized = contextConfig.roles.some((r) => scopeSet.has(r));
        if (!isAuthorized) {
          const text = schema.getUnauthorizedText(fieldName, contextName);
          result[fieldName] = { unauthorized: true, text };
        }
      }
    }
  }

  return result;
};

// Create a redaction engine that combines schema-driven redaction with custom hooks.
export const createRedactionEngine = ({
  schema,
  contexts,
  redactionHooks = {},
} = {}) => {
  const redact = (changeInfo, scopes) => {
    let payload = changeInfo;

    // Step 1: schema-driven redaction
    if (schema && contexts) {
      payload = redactPayload(payload, schema, contexts, scopes);
    }

    // Step 2: apply custom redaction hook if registered for this read model
    const readModelName = changeInfo.readModelName;
    const hook = redactionHooks[readModelName];
    if (hook) {
      payload = hook(payload, scopes);
    }

    return payload;
  };

  return { redact };
};
