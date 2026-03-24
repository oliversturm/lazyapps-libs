import { getLogger } from '@lazyapps/logger';

export const defineEncryptionSchema = (schemaDef) => {
  const log = getLogger('Encryption/Schema', 'INIT');

  const defaults = {
    forgottenText: '[deleted]',
    unauthorizedText: '[restricted]',
    ...(schemaDef.defaults || {}),
  };

  const contexts = schemaDef.contexts || {};
  const events = schemaDef.events || {};

  for (const [eventType, fields] of Object.entries(events)) {
    for (const [fieldPath, config] of Object.entries(fields)) {
      if (!config.context) {
        throw new Error(
          `Encryption schema: field ${fieldPath} in ${eventType} missing 'context'`,
        );
      }
      if (!config.subjectField) {
        throw new Error(
          `Encryption schema: field ${fieldPath} in ${eventType} missing 'subjectField'`,
        );
      }
    }
  }

  const result = {};
  for (const [eventType, fields] of Object.entries(events)) {
    result[eventType] = fields;
  }

  Object.defineProperty(result, 'getForgottenText', {
    value: (fieldName, contextName) => {
      const ctx = contexts[contextName];
      if (ctx) {
        const fieldConfig = ctx.fields && ctx.fields[fieldName];
        if (fieldConfig && fieldConfig.forgottenText !== undefined) {
          return fieldConfig.forgottenText;
        }
        if (ctx.forgottenText !== undefined) {
          return ctx.forgottenText;
        }
      }
      return defaults.forgottenText;
    },
    enumerable: false,
  });

  Object.defineProperty(result, 'getUnauthorizedText', {
    value: (fieldName, contextName) => {
      const ctx = contexts[contextName];
      if (ctx) {
        const fieldConfig = ctx.fields && ctx.fields[fieldName];
        if (fieldConfig && fieldConfig.unauthorizedText !== undefined) {
          return fieldConfig.unauthorizedText;
        }
        if (ctx.unauthorizedText !== undefined) {
          return ctx.unauthorizedText;
        }
      }
      return defaults.unauthorizedText;
    },
    enumerable: false,
  });

  Object.defineProperty(result, 'getPiiPaths', {
    value: () => [
      ...new Set(
        Object.values(events).flatMap((fields) => Object.keys(fields)),
      ),
    ],
    enumerable: false,
  });

  log.debug(
    `Encryption schema defined for ${Object.keys(events).length} event types`,
  );

  return result;
};
