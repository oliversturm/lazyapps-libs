import { getLogger } from '@lazyapps/logger';

const createVaultClient = (vaultUrl) => {
  const state = { token: null, renewTimer: null };

  const request = (method, path, body) =>
    fetch(`${vaultUrl}/v1/${path}`, {
      method,
      headers: {
        'X-Vault-Token': state.token,
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

  const scheduleRenewal = (leaseDuration, log, reAuth) => {
    if (state.renewTimer) clearTimeout(state.renewTimer);
    if (!leaseDuration || leaseDuration <= 0) return;

    // Renew at 80% of lease duration
    const renewIn = Math.floor(leaseDuration * 0.8) * 1000;
    log.debug(`Scheduling token renewal in ${Math.floor(renewIn / 1000)}s`);

    state.renewTimer = setTimeout(() => {
      log.info('Renewing Vault token');
      request('POST', 'auth/token/renew-self')
        .then((res) => {
          const newLease = res.auth && res.auth.lease_duration;
          log.info(`Token renewed, new lease: ${newLease}s`);
          scheduleRenewal(newLease, log, reAuth);
        })
        .catch((err) => {
          log.warn(`Token renewal failed: ${err.message}, re-authenticating`);
          reAuth()
            .then(({ token, leaseDuration: newLease }) => {
              state.token = token;
              scheduleRenewal(newLease, log, reAuth);
            })
            .catch((reAuthErr) =>
              log.error(`Re-authentication failed: ${reAuthErr.message}`),
            );
        });
    }, renewIn);

    // Allow process to exit without waiting for the timer
    if (state.renewTimer.unref) state.renewTimer.unref();
  };

  const stopRenewal = () => {
    if (state.renewTimer) {
      clearTimeout(state.renewTimer);
      state.renewTimer = null;
    }
  };

  return { state, request, scheduleRenewal, stopRenewal };
};

const authenticateAppRole = (vaultUrl, roleId, secretId) =>
  fetch(`${vaultUrl}/v1/auth/approle/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role_id: roleId, secret_id: secretId }),
  }).then((res) =>
    res.ok
      ? res.json().then((data) => ({
          token: data.auth.client_token,
          leaseDuration: data.auth.lease_duration,
          renewable: data.auth.renewable,
        }))
      : res.json().then((err) => {
          const error = new Error(
            `Vault AppRole login: ${err.errors?.[0] || res.statusText}`,
          );
          error.status = res.status;
          throw error;
        }),
  );

const initDekInMemory = () => {
  const deks = new Map();
  const forgotten = new Map();
  return Promise.resolve({
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
    isForgotten: (subjectId, contextName) => {
      const subjectForgotten = forgotten.get(subjectId);
      if (
        subjectForgotten &&
        (subjectForgotten.has(contextName) || subjectForgotten.has('*'))
      )
        return Promise.resolve(true);
      return Promise.resolve(false);
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
};

const initDekMongo = ({ url, database, collection }) =>
  import('mongodb').then(({ MongoClient }) =>
    MongoClient.connect(url).then((client) => {
      const db = client.db(database);
      const coll = db.collection(collection);
      const forgottenColl = db.collection(`${collection}-forgotten`);
      return {
        getDEK: (subjectId, contextName) =>
          forgottenColl
            .findOne({
              subjectId,
              $or: [
                { context: contextName },
                { context: '*' },
                { context: { $exists: false } },
              ],
            })
            .then((forgotten) => {
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
        isForgotten: (subjectId, contextName) =>
          forgottenColl
            .findOne({
              subjectId,
              $or: [
                { context: contextName },
                { context: '*' },
                { context: { $exists: false } },
              ],
            })
            .then((doc) => !!doc),
        deleteKeysForSubjectContext: (subjectId, contextName) =>
          forgottenColl
            .updateOne(
              { subjectId, context: contextName },
              {
                $set: {
                  subjectId,
                  context: contextName,
                  deletedAt: Date.now(),
                },
              },
              { upsert: true },
            )
            .then(() => coll.deleteMany({ subjectId, context: contextName }))
            .then(() => {}),
        deleteKeysForSubject: (subjectId) =>
          forgottenColl
            .updateOne(
              { subjectId, context: '*' },
              {
                $set: {
                  subjectId,
                  context: '*',
                  deletedAt: Date.now(),
                },
              },
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
    const client = createVaultClient(vaultUrl);

    const reAuth = authMethod
      ? () =>
          authenticateAppRole(
            vaultUrl,
            authMethod.roleId,
            authMethod.secretId,
          ).then((auth) => {
            client.state.token = auth.token;
            return auth;
          })
      : null;

    const getToken = token
      ? Promise.resolve({ token, leaseDuration: 0, renewable: false })
      : authenticateAppRole(vaultUrl, authMethod.roleId, authMethod.secretId);

    return getToken.then((auth) => {
      client.state.token = auth.token;

      if (auth.renewable && auth.leaseDuration > 0 && reAuth) {
        client.scheduleRenewal(auth.leaseDuration, log, reAuth);
      }

      log.info(`Vault key store connected to ${vaultUrl}`);

      const dekStore = dekBackend
        ? initDekMongo(dekBackend)
        : initDekInMemory();

      return dekStore.then((deks) => ({
        wrapDEK: (contextName, plainDEK) =>
          client
            .request('POST', `transit/encrypt/${contextName}`, {
              plaintext: plainDEK.toString('base64'),
            })
            .then((res) => res.data.ciphertext),

        unwrapDEK: (contextName, wrappedDEK) =>
          client
            .request('POST', `transit/decrypt/${contextName}`, {
              ciphertext: wrappedDEK,
            })
            .then((res) => Buffer.from(res.data.plaintext, 'base64')),

        getDEK: deks.getDEK,
        isForgotten: deks.isForgotten,
        storeDEK: deks.storeDEK,
        getAllDEKsForContext: deks.getAllDEKsForContext,
        deleteKeysForSubjectContext: deks.deleteKeysForSubjectContext,
        deleteKeysForSubject: deks.deleteKeysForSubject,

        rotateKEK: (contextName) =>
          client.request('POST', `transit/keys/${contextName}/rotate`),

        close: () => {
          client.stopRenewal();
          return deks.close ? deks.close() : Promise.resolve();
        },
      }));
    });
  },
});
