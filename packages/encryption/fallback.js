import { getNestedValue, setNestedValue } from './pathUtils.js';

export const createFallbackHandler = (
  schema,
  defaultFallback = '[deleted]',
) => ({
  applyFallbacks: (event) => {
    const fieldDefs = schema[event.type];
    if (!fieldDefs) return Promise.resolve(event);

    const result = { ...event, payload: { ...event.payload } };

    for (const [fieldPath, fieldConfig] of Object.entries(fieldDefs)) {
      const value = getNestedValue(result, fieldPath);
      if (value && value.__encrypted) {
        const fallback = fieldConfig.fallback || defaultFallback;
        setNestedValue(result, fieldPath, fallback);
      }
    }

    return Promise.resolve(result);
  },
});
