import { MongoClient } from 'mongodb';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'node:crypto';
import { getLogger } from '@lazyapps/logger';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;

const deriveKEK = (rootSecret, contextName) => {
  const hmac = createHmac('sha256', rootSecret);
  hmac.update(contextName);
  return hmac.digest();
};

const wrapLocal = (kek, plainDEK) => {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, kek, iv);
  const encrypted = Buffer.concat([cipher.update(plainDEK), cipher.final()]);
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
  );
  decipher.setAuthTag(Buffer.from(wrapped.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(wrapped.data, 'base64')),
    decipher.final(),
  ]);
};

export const mongoKeyStore = ({
  url,
  rootSecret,
  database = 'encryption-keys',
  dekCollection = 'deks',
}) => ({
  initialize: () => {
    const log = getLogger('Encryption/KS', 'INIT');
    const secret = Buffer.isBuffer(rootSecret)
      ? rootSecret
      : Buffer.from(rootSecret, 'base64');

    const forgottenCollection = `${dekCollection}-forgotten`;

    return MongoClient.connect(url).then((client) => {
      const db = client.db(database);
      log.info(`Key store connected to ${database}`);
      return {
        wrapDEK: (contextName, plainDEK) =>
          Promise.resolve(wrapLocal(deriveKEK(secret, contextName), plainDEK)),

        unwrapDEK: (contextName, wrappedDEK) =>
          Promise.resolve(
            unwrapLocal(deriveKEK(secret, contextName), wrappedDEK),
          ),

        getDEK: (subjectId, contextName, version) =>
          db
            .collection(forgottenCollection)
            .findOne({ subjectId })
            .then((forgotten) => {
              if (forgotten) return { forgotten: true };
              const filter = { subjectId, context: contextName };
              if (version) filter.version = version;
              return db
                .collection(dekCollection)
                .findOne(filter, { sort: { version: -1 } })
                .then((doc) =>
                  doc
                    ? {
                        wrappedKey: {
                          iv: doc.iv,
                          data: doc.data,
                          tag: doc.tag,
                        },
                        version: doc.version,
                      }
                    : null,
                );
            }),

        storeDEK: (subjectId, contextName, dekInfo) =>
          db.collection(dekCollection).insertOne({
            subjectId,
            context: contextName,
            version: dekInfo.version,
            iv: dekInfo.wrappedKey.iv,
            data: dekInfo.wrappedKey.data,
            tag: dekInfo.wrappedKey.tag,
            createdAt: Date.now(),
          }),

        getAllDEKsForContext: (contextName) =>
          db
            .collection(dekCollection)
            .find({ context: contextName })
            .toArray()
            .then((docs) =>
              docs.map((d) => ({
                subjectId: d.subjectId,
                wrappedKey: { iv: d.iv, data: d.data, tag: d.tag },
                version: d.version,
              })),
            ),

        deleteKeysForSubject: (subjectId) => {
          const ksLog = getLogger('Encryption/KS', 'ADMIN');
          ksLog.info(`Deleting all keys for subject: ${subjectId}`);
          return db
            .collection(forgottenCollection)
            .updateOne(
              { subjectId },
              { $set: { subjectId, deletedAt: Date.now() } },
              { upsert: true },
            )
            .then(() => db.collection(dekCollection).deleteMany({ subjectId }))
            .then((result) => {
              ksLog.info(
                `Deleted ${result.deletedCount} keys for ${subjectId}`,
              );
            });
        },

        close: () => client.close(),
      };
    });
  },
});
