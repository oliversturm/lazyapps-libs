import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { metrics } from '@opentelemetry/api';
import { getLogger } from '@lazyapps/logger';
import { getNestedValue, setNestedValue } from './pathUtils.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

// SEC-16: track every decryption outcome so operators can distinguish the
// "benign" forgotten case from real tampering / config drift.
const meter = metrics.getMeter('@lazyapps/encryption');
const decryptionEventsCounter = meter.createCounter(
  'lazyapps.encryption.decryption.events',
  {
    description:
      'Decryption outcomes per field: success, forgotten, or failed.',
  },
);

const FAILURE_MARKER_TEXT = '[ENCRYPTED — DECRYPTION FAILED]';

export const encryptValue = (key, plaintext) => {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: 16 });
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
    { authTagLength: 16 },
  );
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return (
    decipher.update(Buffer.from(envelope.data, 'base64'), null, 'utf8') +
    decipher.final('utf8')
  );
};

const applyFieldFallback = (schema, evt, fieldPath, contextName) => {
  const fieldName = fieldPath.split('.').pop();
  const text = schema.getForgottenText(fieldName, contextName);
  return setNestedValue(evt, fieldPath, { forgotten: true, text });
};

// SEC-16: a distinct marker shape for tampered / undecryptable ciphertext
// that is NOT a crypto-shredding forgotten case. Callers (read models,
// aggregate projections) can tell the two apart by key: `forgotten` vs.
// `decryptionFailed`. Keys must be EXACTLY these two — downstream tests
// assert `Object.keys(marker).sort() === ['decryptionFailed', 'text']`.
const applyFieldFailureMarker = (evt, fieldPath) =>
  setNestedValue(evt, fieldPath, {
    decryptionFailed: true,
    text: FAILURE_MARKER_TEXT,
  });

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
              wk: dek.wrappedKey,
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
    const decryptLog = getLogger('Encryption/Field', 'DECRYPT');

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

          return envelope
            .getDEK(value.kid, value.ctx, value.kv, value.wk)
            .then((dek) => {
              if (dek.forgotten) {
                // Defensive branch — current envelopeEncryption rejects with
                // SUBJECT_FORGOTTEN rather than resolving with this shape,
                // but we honour it in case alternate key stores return it.
                decryptionEventsCounter.add(1, {
                  result: 'forgotten',
                  context: value.ctx,
                });
                decryptLog.info(
                  `Forgotten fallback applied subject=${value.kid} ` +
                    `context=${value.ctx} field=${fieldPath}`,
                );
                return applyFieldFallback(schema, evt, fieldPath, value.ctx);
              }
              const plaintext = decryptValue(dek.key, value);
              decryptionEventsCounter.add(1, {
                result: 'success',
                context: value.ctx,
              });
              return setNestedValue(evt, fieldPath, plaintext);
            })
            .catch((err) => {
              // SEC-16 discriminator: a forgotten subject produces a named
              // SUBJECT_FORGOTTEN rejection inside envelopeEncryption. Any
              // other failure — auth-tag mismatch, KEK_NOT_FOUND, bad
              // base64, etc. — means the ciphertext is present but
              // undecryptable, which is the case we now surface loudly.
              const isForgotten =
                err && (err.code === 'SUBJECT_FORGOTTEN' || err.forgotten);

              if (isForgotten) {
                decryptionEventsCounter.add(1, {
                  result: 'forgotten',
                  context: value.ctx,
                });
                decryptLog.info(
                  `Forgotten fallback applied subject=${value.kid} ` +
                    `context=${value.ctx} field=${fieldPath}`,
                );
                return applyFieldFallback(schema, evt, fieldPath, value.ctx);
              }

              decryptionEventsCounter.add(1, {
                result: 'failed',
                context: value.ctx,
              });
              // Deliberately include subject, context, and field path so
              // operators can correlate incidents, but NEVER the plaintext
              // or the raw ciphertext bytes (`value.data`) — only the
              // underlying error class and message.
              const errName = (err && err.name) || 'Error';
              const errMsg = (err && err.message) || String(err);
              decryptLog.error(
                `Decryption FAILED subject=${value.kid} ` +
                  `context=${value.ctx} field=${fieldPath}: ` +
                  `${errName}: ${errMsg}`,
              );
              return applyFieldFailureMarker(evt, fieldPath);
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
