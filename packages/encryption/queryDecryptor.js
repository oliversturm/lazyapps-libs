import { decryptValue } from './fieldEncryption.js';
import { getLogger } from '@lazyapps/logger';

export const createQueryDecryptor = (
  readModelEncryption,
  envelope,
  schema,
  contexts,
) => {
  const log = getLogger('Encryption/Query', 'INIT');

  log.info('Query decryptor initialized');

  return {
    decrypt: (doc, { roles, identity, subjectField }) => {
      if (!doc) return Promise.resolve(doc);

      const docLevelSelf =
        subjectField &&
        identity &&
        doc[subjectField] &&
        identity === doc[subjectField];

      const encryptedFields = Object.entries(doc).filter(
        ([, value]) => value && value.__encrypted,
      );

      if (encryptedFields.length === 0) return Promise.resolve(doc);

      return encryptedFields.reduce(
        (promise, [fieldName, fieldValue]) =>
          promise.then((d) => {
            const isSelf =
              docLevelSelf ||
              (!subjectField &&
                identity &&
                fieldValue.kid &&
                identity === fieldValue.kid);
            const effectiveRoles = isSelf ? [...roles, 'self'] : [...roles];

            const contextConfig = contexts[fieldValue.ctx];
            const isAuthorized =
              contextConfig &&
              contextConfig.roles.some((r) => effectiveRoles.includes(r));

            if (!isAuthorized) {
              const text = schema.getUnauthorizedText(
                fieldName,
                fieldValue.ctx,
              );
              return { ...d, [fieldName]: { unauthorized: true, text } };
            }

            return envelope
              .getDEK(
                fieldValue.kid,
                fieldValue.ctx,
                fieldValue.kv,
                fieldValue.wk,
              )
              .then((dek) => ({
                ...d,
                [fieldName]: decryptValue(dek.key, fieldValue),
              }))
              .catch(() => {
                const text = schema.getForgottenText(fieldName, fieldValue.ctx);
                return { ...d, [fieldName]: { forgotten: true, text } };
              });
          }),
        Promise.resolve({ ...doc }),
      );
    },
  };
};
