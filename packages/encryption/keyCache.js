export const createKeyCache = (
  keyStore,
  { maxSize = 10000, ttlMs = 300000 },
) => {
  const cache = new Map();

  const evictExpired = () => {
    const now = Date.now();
    for (const [key, entry] of cache) {
      if (entry.expiresAt < now) cache.delete(key);
    }
  };

  const evictLRU = () => {
    if (cache.size <= maxSize) return;
    const firstKey = cache.keys().next().value;
    cache.delete(firstKey);
  };

  return {
    ...keyStore,

    getDEK: (subjectId, contextName, version) => {
      const cacheKey = `${subjectId}:${contextName}:${version || 'latest'}`;
      const cached = cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        cache.delete(cacheKey);
        cache.set(cacheKey, cached);
        return Promise.resolve(cached.value);
      }

      return keyStore.getDEK(subjectId, contextName, version).then((dek) => {
        if (dek) {
          evictExpired();
          cache.set(cacheKey, {
            value: dek,
            expiresAt: Date.now() + ttlMs,
          });
          evictLRU();
        }
        return dek;
      });
    },

    deleteKeysForSubjectContext: (subjectId, contextName) => {
      const prefix = `${subjectId}:${contextName}:`;
      for (const key of cache.keys()) {
        if (key.startsWith(prefix)) cache.delete(key);
      }
      return keyStore.deleteKeysForSubjectContext(subjectId, contextName);
    },

    deleteKeysForSubject: (subjectId) => {
      for (const key of cache.keys()) {
        if (key.startsWith(`${subjectId}:`)) cache.delete(key);
      }
      return keyStore.deleteKeysForSubject(subjectId);
    },
  };
};
