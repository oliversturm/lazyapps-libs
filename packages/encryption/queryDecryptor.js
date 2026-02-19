import { decryptValue } from './fieldEncryption.js';
import { getLogger } from '@lazyapps/logger';

export const createQueryDecryptor = (
  readModelEncryption,
  envelope,
  fallbackValue,
  contexts,
) => {
  const log = getLogger('Encryption/Query', 'INIT');

  log.info('Query decryptor initialized');

  return {
    decrypt: (doc, { roles, identity, subjectField }) => {
      if (!doc) return Promise.resolve(doc);

      const isSelf =
        identity && doc[subjectField] && identity === doc[subjectField];
      const effectiveRoles = isSelf ? [...roles, 'self'] : [...roles];

      const encryptedFields = Object.entries(doc).filter(
        ([, value]) => value && value.__encrypted,
      );

      if (encryptedFields.length === 0) return Promise.resolve(doc);

      return encryptedFields.reduce(
        (promise, [fieldName, fieldValue]) =>
          promise.then((d) => {
            const contextConfig = contexts[fieldValue.ctx];
            const isAuthorized =
              contextConfig &&
              contextConfig.roles.some((r) => effectiveRoles.includes(r));

            if (!isAuthorized) {
              return { ...d, [fieldName]: '[restricted]' };
            }

            return envelope
              .getDEK(fieldValue.kid, fieldValue.ctx, fieldValue.kv)
              .then((dek) => ({
                ...d,
                [fieldName]: decryptValue(dek.key, fieldValue),
              }))
              .catch(() => ({
                ...d,
                [fieldName]: fallbackValue,
              }));
          }),
        Promise.resolve({ ...doc }),
      );
    },
  };
};
