import { randomBytes } from 'node:crypto';

export const createEnvelopeManager = (keyStore, contexts) => {
  const dekCache = new Map();

  const cacheKey = (subjectId, contextName) => `${subjectId}:${contextName}`;

  const cacheDEK = (subjectId, contextName, dekInfo) => {
    dekCache.set(cacheKey(subjectId, contextName), dekInfo);
    return dekInfo;
  };

  return {
    getDEK: (subjectId, contextName, version, wrappedKey) => {
      const cached = dekCache.get(cacheKey(subjectId, contextName));
      if (cached) return Promise.resolve(cached);

      return keyStore
        .getDEK(subjectId, contextName, version)
        .then((storedDEK) => {
          if (storedDEK && storedDEK.forgotten) {
            return Promise.reject(
              Object.assign(
                new Error(`Keys for subject ${subjectId} have been forgotten`),
                { code: 'SUBJECT_FORGOTTEN' },
              ),
            );
          }
          if (!storedDEK) {
            if (wrappedKey) {
              return keyStore
                .unwrapDEK(contextName, wrappedKey)
                .then((plainDEK) => ({
                  key: plainDEK,
                  version: version || 1,
                  wrappedKey,
                }))
                .then((dekInfo) =>
                  keyStore
                    .storeDEK(subjectId, contextName, dekInfo)
                    .then(() => cacheDEK(subjectId, contextName, dekInfo)),
                );
            }
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
                  .then(() => cacheDEK(subjectId, contextName, dekInfo)),
              );
          }
          return keyStore
            .unwrapDEK(contextName, storedDEK.wrappedKey)
            .then((plainDEK) =>
              cacheDEK(subjectId, contextName, {
                key: plainDEK,
                version: storedDEK.version,
                wrappedKey: storedDEK.wrappedKey,
              }),
            );
        });
    },

    clearCachedDEKs: (subjectId, contextName) => {
      if (contextName) {
        dekCache.delete(cacheKey(subjectId, contextName));
      } else {
        for (const key of dekCache.keys()) {
          if (key.startsWith(`${subjectId}:`)) dekCache.delete(key);
        }
      }
    },

    rotateKEK: (contextName) =>
      keyStore.rotateKEK
        ? keyStore.rotateKEK(contextName)
        : Promise.reject(
            new Error('KEK rotation not supported by this key store tier'),
          ),
  };
};
