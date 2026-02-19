import { getLogger } from '@lazyapps/logger';

export const defineEncryptionSchema = (schemaDef) => {
  const log = getLogger('Encryption/Schema', 'INIT');

  for (const [eventType, fields] of Object.entries(schemaDef)) {
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

  log.debug(
    `Encryption schema defined for ${Object.keys(schemaDef).length} event types`,
  );

  return schemaDef;
};
