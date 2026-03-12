import { getNestedValue, setNestedValue } from './pathUtils.js';

export const createFallbackHandler = (schema) => ({
  applyFallbacks: (event) => {
    const fieldDefs = schema[event.type];
    if (!fieldDefs) return Promise.resolve(event);

    const result = { ...event, payload: { ...event.payload } };

    for (const [fieldPath, fieldConfig] of Object.entries(fieldDefs)) {
      const value = getNestedValue(result, fieldPath);
      if (value && value.__encrypted) {
        const fieldName = fieldPath.split('.').pop();
        const text = schema.getForgottenText(fieldName, fieldConfig.context);
        setNestedValue(result, fieldPath, { forgotten: true, text });
      }
    }

    return Promise.resolve(result);
  },
});
