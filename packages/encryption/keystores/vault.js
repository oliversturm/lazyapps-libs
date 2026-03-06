import { getLogger } from '@lazyapps/logger';

const vaultRequest = (vaultUrl, token) => (method, path, body) =>
  fetch(`${vaultUrl}/v1/${path}`, {
    method,
    headers: {
      'X-Vault-Token': token,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  }).then((res) =>
    res.ok
      ? res.json()
      : res.json().then((err) => {
          const error = new Error(
            `Vault ${method} ${path}: ${err.errors?.[0] || res.statusText}`,
          );
          error.status = res.status;
          throw error;
        }),
  );

const authenticateAppRole = (vaultUrl, roleId, secretId) =>
  fetch(`${vaultUrl}/v1/auth/approle/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role_id: roleId, secret_id: secretId }),
  })
    .then((res) => res.json())
    .then((data) => data.auth.client_token);

const initDekInMemory = () => {
  const deks = new Map();
  const forgotten = new Set();
  return Promise.resolve({
    getDEK: (subjectId, contextName) => {
      if (forgotten.has(subjectId)) return Promise.resolve({ forgotten: true });
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
    deleteKeysForSubject: (subjectId) => {
      for (const key of deks.keys()) {
        if (key.startsWith(`${subjectId}:`)) deks.delete(key);
      }
      forgotten.add(subjectId);
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  });
};

const initDekMongo = ({ url, database, collection }) =>
  import('mongodb').then(({ MongoClient }) =>
    MongoClient.connect(url).then((client) => {
      const db = client.db(database);
      const coll = db.collection(collection);
      const forgottenColl = db.collection(`${collection}-forgotten`);
      return {
        getDEK: (subjectId, contextName) =>
          forgottenColl.findOne({ subjectId }).then((forgotten) => {
            if (forgotten) return { forgotten: true };
            return coll
              .findOne(
                { subjectId, context: contextName },
                { sort: { version: -1 } },
              )
              .then((doc) =>
                doc
                  ? { wrappedKey: doc.wrappedKey, version: doc.version }
                  : null,
              );
          }),
        storeDEK: (subjectId, contextName, dekInfo) =>
          coll.insertOne({
            subjectId,
            context: contextName,
            wrappedKey: dekInfo.wrappedKey,
            version: dekInfo.version,
            createdAt: Date.now(),
          }),
        getAllDEKsForContext: (contextName) =>
          coll
            .find({ context: contextName })
            .toArray()
            .then((docs) =>
              docs.map((d) => ({
                subjectId: d.subjectId,
                wrappedKey: d.wrappedKey,
                version: d.version,
              })),
            ),
        deleteKeysForSubject: (subjectId) =>
          forgottenColl
            .updateOne(
              { subjectId },
              { $set: { subjectId, deletedAt: Date.now() } },
              { upsert: true },
            )
            .then(() => coll.deleteMany({ subjectId }))
            .then(() => {}),
        close: () => client.close(),
      };
    }),
  );

export const appRole = ({ roleId, secretId }) => ({ roleId, secretId });

export const vaultKeyStore = ({ vaultUrl, token, authMethod, dekBackend }) => ({
  initialize: () => {
    const log = getLogger('Encryption/Vault', 'INIT');

    const getToken = token
      ? Promise.resolve(token)
      : authenticateAppRole(vaultUrl, authMethod.roleId, authMethod.secretId);

    return getToken.then((vaultToken) => {
      const request = vaultRequest(vaultUrl, vaultToken);
      log.info(`Vault key store connected to ${vaultUrl}`);

      const dekStore = dekBackend
        ? initDekMongo(dekBackend)
        : initDekInMemory();

      return dekStore.then((deks) => ({
        wrapDEK: (contextName, plainDEK) =>
          request('POST', `transit/encrypt/${contextName}`, {
            plaintext: plainDEK.toString('base64'),
          }).then((res) => res.data.ciphertext),

        unwrapDEK: (contextName, wrappedDEK) =>
          request('POST', `transit/decrypt/${contextName}`, {
            ciphertext: wrappedDEK,
          }).then((res) => Buffer.from(res.data.plaintext, 'base64')),

        getDEK: deks.getDEK,
        storeDEK: deks.storeDEK,
        getAllDEKsForContext: deks.getAllDEKsForContext,
        deleteKeysForSubject: deks.deleteKeysForSubject,

        rotateKEK: (contextName) =>
          request('POST', `transit/keys/${contextName}/rotate`),

        close: deks.close || (() => Promise.resolve()),
      }));
    });
  },
});
