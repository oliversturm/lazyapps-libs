import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { getNestedValue, setNestedValue } from './pathUtils.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

export const encryptValue = (key, plaintext) => {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(String(plaintext), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    __encrypted: true,
    alg: ALGORITHM,
    iv: iv.toString('base64'),
    data: encrypted.toString('base64'),
    tag: tag.toString('base64'),
  };
};

export const decryptValue = (key, envelope) => {
  const decipher = createDecipheriv(
    envelope.alg || ALGORITHM,
    key,
    Buffer.from(envelope.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return (
    decipher.update(Buffer.from(envelope.data, 'base64'), null, 'utf8') +
    decipher.final('utf8')
  );
};

export const createFieldEncryptor = (envelope, schema) => ({
  encryptEvent: (event) => {
    const fieldDefs = schema[event.type];
    if (!fieldDefs) return Promise.resolve(event);

    const encrypted = { ...event, payload: { ...event.payload } };

    return Object.entries(fieldDefs).reduce(
      (promise, [fieldPath, fieldConfig]) =>
        promise.then((evt) => {
          const value = getNestedValue(evt, fieldPath);
          if (value === undefined || value === null) return evt;

          const subjectId = getNestedValue(evt, fieldConfig.subjectField);
          if (!subjectId) return evt;

          return envelope.getDEK(subjectId, fieldConfig.context).then((dek) => {
            const encryptedField = {
              ...encryptValue(dek.key, value),
              ctx: fieldConfig.context,
              kid: subjectId,
              kv: dek.version,
            };
            return setNestedValue(evt, fieldPath, encryptedField);
          });
        }),
      Promise.resolve(encrypted),
    );
  },

  decryptEvent: (event, accessControl) => {
    const fieldDefs = schema[event.type];
    if (!fieldDefs) return Promise.resolve(event);

    const decrypted = { ...event, payload: { ...event.payload } };

    return Object.entries(fieldDefs).reduce(
      (promise, [fieldPath, fieldConfig]) =>
        promise.then((evt) => {
          const value = getNestedValue(evt, fieldPath);
          if (!value || !value.__encrypted) return evt;

          if (accessControl) {
            const contextConfig = accessControl.contexts[value.ctx];
            if (
              contextConfig &&
              !contextConfig.roles.includes(accessControl.role)
            ) {
              return evt;
            }
          }

          return envelope.getDEK(value.kid, value.ctx, value.kv).then((dek) => {
            const plaintext = decryptValue(dek.key, value);
            return setNestedValue(evt, fieldPath, plaintext);
          });
        }),
      Promise.resolve(decrypted),
    );
  },

  hasEncryptedFields: (event) => {
    const fieldDefs = schema[event.type];
    if (!fieldDefs) return false;
    return Object.keys(fieldDefs).some((fieldPath) => {
      const value = getNestedValue(event, fieldPath);
      return value && value.__encrypted;
    });
  },
});
