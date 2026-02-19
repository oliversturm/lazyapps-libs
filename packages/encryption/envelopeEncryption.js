import { randomBytes } from 'node:crypto';

export const createEnvelopeManager = (keyStore, contexts) => ({
  getDEK: (subjectId, contextName, version) =>
    keyStore.getDEK(subjectId, contextName, version).then((storedDEK) => {
      if (!storedDEK) {
        const newDEK = randomBytes(32);
        return keyStore
          .wrapDEK(contextName, newDEK)
          .then((wrappedKey) => ({
            key: newDEK,
            version: 1,
            wrappedKey,
          }))
          .then((dekInfo) =>
            keyStore
              .storeDEK(subjectId, contextName, dekInfo)
              .then(() => dekInfo),
          );
      }
      return keyStore
        .unwrapDEK(contextName, storedDEK.wrappedKey)
        .then((plainDEK) => ({
          key: plainDEK,
          version: storedDEK.version,
        }));
    }),

  rotateKEK: (contextName) =>
    keyStore.rotateKEK
      ? keyStore.rotateKEK(contextName)
      : Promise.reject(
          new Error('KEK rotation not supported by this key store tier'),
        ),
});
