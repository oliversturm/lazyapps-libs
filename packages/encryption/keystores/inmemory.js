import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

export const inMemoryKeyStore = (initialKEKs = {}) => ({
  initialize: () => {
    const keks = new Map(
      Object.entries(initialKEKs).map(([k, v]) => [
        k,
        Buffer.isBuffer(v) ? v : Buffer.from(v, 'base64'),
      ]),
    );
    const deks = new Map();
    const forgotten = new Map();

    const wrapLocal = (kek, plainDEK) => {
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv(ALGORITHM, kek, iv, { authTagLength: 16 });
      const encrypted = Buffer.concat([
        cipher.update(plainDEK),
        cipher.final(),
      ]);
      const tag = cipher.getAuthTag();
      return {
        iv: iv.toString('base64'),
        data: encrypted.toString('base64'),
        tag: tag.toString('base64'),
      };
    };

    const unwrapLocal = (kek, wrapped) => {
      const decipher = createDecipheriv(
        ALGORITHM,
        kek,
        Buffer.from(wrapped.iv, 'base64'),
        { authTagLength: 16 },
      );
      decipher.setAuthTag(Buffer.from(wrapped.tag, 'base64'));
      return Buffer.concat([
        decipher.update(Buffer.from(wrapped.data, 'base64')),
        decipher.final(),
      ]);
    };

    return Promise.resolve({
      wrapDEK: (contextName, plainDEK) =>
        keks.has(contextName)
          ? Promise.resolve(wrapLocal(keks.get(contextName), plainDEK))
          : Promise.reject(
              Object.assign(new Error(`KEK not found: ${contextName}`), {
                code: 'KEK_NOT_FOUND',
              }),
            ),

      unwrapDEK: (contextName, wrappedDEK) =>
        keks.has(contextName)
          ? Promise.resolve(unwrapLocal(keks.get(contextName), wrappedDEK))
          : Promise.reject(
              Object.assign(new Error(`KEK not found: ${contextName}`), {
                code: 'KEK_NOT_FOUND',
              }),
            ),

      getDEK: (subjectId, contextName) => {
        const subjectForgotten = forgotten.get(subjectId);
        if (
          subjectForgotten &&
          (subjectForgotten.has(contextName) || subjectForgotten.has('*'))
        )
          return Promise.resolve({ forgotten: true });
        const key = `${subjectId}:${contextName}`;
        return Promise.resolve(deks.get(key) || null);
      },

      storeDEK: (subjectId, contextName, dekInfo) => {
        deks.set(`${subjectId}:${contextName}`, {
          wrappedKey: dekInfo.wrappedKey,
          version: dekInfo.version,
        });
        return Promise.resolve();
      },

      getAllDEKsForContext: (contextName) =>
        Promise.resolve(
          Array.from(deks.entries())
            .filter(([k]) => k.endsWith(`:${contextName}`))
            .map(([k, v]) => ({ subjectId: k.split(':')[0], ...v })),
        ),

      isForgotten: (subjectId, contextName) => {
        const subjectForgotten = forgotten.get(subjectId);
        if (
          subjectForgotten &&
          (subjectForgotten.has(contextName) || subjectForgotten.has('*'))
        )
          return Promise.resolve(true);
        return Promise.resolve(false);
      },

      deleteKeysForSubjectContext: (subjectId, contextName) => {
        const key = `${subjectId}:${contextName}`;
        deks.delete(key);
        const existing = forgotten.get(subjectId);
        if (existing) {
          existing.add(contextName);
        } else {
          forgotten.set(subjectId, new Set([contextName]));
        }
        return Promise.resolve();
      },

      deleteKeysForSubject: (subjectId) => {
        for (const key of deks.keys()) {
          if (key.startsWith(`${subjectId}:`)) deks.delete(key);
        }
        forgotten.set(subjectId, new Set(['*']));
        return Promise.resolve();
      },

      close: () => Promise.resolve(),
    });
  },
});
