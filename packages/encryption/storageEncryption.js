import { encryptValue } from './fieldEncryption.js';
import { getLogger } from '@lazyapps/logger';

export const createStorageEncryptor = (
  storageFactory,
  readModelEncryption,
  envelope,
) => {
  const log = getLogger('Encryption/Storage', 'INIT');

  const encryptFields = (collection, target, subjectIdContext) => {
    const collectionSchema = readModelEncryption[collection];
    if (!collectionSchema) return Promise.resolve(target);
    return Object.entries(collectionSchema).reduce(
      (promise, [fieldName, fieldConfig]) =>
        promise.then((t) => {
          const value = t[fieldName];
          if (value === undefined || value === null) return t;
          const subjectId =
            t[fieldConfig.subjectField] ||
            (subjectIdContext && subjectIdContext[fieldConfig.subjectField]);
          if (!subjectId) return t;
          return envelope
            .getDEK(subjectId, fieldConfig.context)
            .then((dek) => ({
              ...t,
              [fieldName]: {
                ...encryptValue(dek.key, value),
                ctx: fieldConfig.context,
                kid: subjectId,
                kv: dek.version,
              },
            }));
        }),
      Promise.resolve({ ...target }),
    );
  };

  const encryptUpdate = (collection, filter, update) => {
    if (update.$set) {
      return encryptFields(collection, update.$set, filter).then(
        (encryptedSet) => ({ ...update, $set: encryptedSet }),
      );
    }
    const hasOperators = Object.keys(update).some((k) => k.startsWith('$'));
    if (!hasOperators) {
      return encryptFields(collection, update, filter);
    }
    return Promise.resolve(update);
  };

  const encryptBulkOp = (collection, op) => {
    if (op.insertOne)
      return encryptFields(collection, op.insertOne.document).then((doc) => ({
        insertOne: { document: doc },
      }));
    if (op.updateOne)
      return encryptUpdate(
        collection,
        op.updateOne.filter,
        op.updateOne.update,
      ).then((update) => ({
        updateOne: { ...op.updateOne, update },
      }));
    if (op.updateMany)
      return encryptUpdate(
        collection,
        op.updateMany.filter,
        op.updateMany.update,
      ).then((update) => ({
        updateMany: { ...op.updateMany, update },
      }));
    if (op.replaceOne)
      return encryptFields(
        collection,
        op.replaceOne.replacement,
        op.replaceOne.filter,
      ).then((replacement) => ({
        replaceOne: { ...op.replaceOne, replacement },
      }));
    return Promise.resolve(op);
  };

  const wrapPerRequest = (perRequest) => (correlationId) => {
    const methods = perRequest(correlationId);
    const encLog = getLogger('Encryption/Storage', correlationId);

    return {
      ...methods,

      insertOne: (collection, doc) =>
        encryptFields(collection, doc).then((encrypted) => {
          encLog.debug(`Encrypting insertOne for ${collection}`);
          return methods.insertOne(collection, encrypted);
        }),

      insertMany: (collection, docs) =>
        Promise.all(docs.map((doc) => encryptFields(collection, doc))).then(
          (encrypted) => {
            encLog.debug(
              `Encrypting insertMany (${docs.length} docs) ` +
                `for ${collection}`,
            );
            return methods.insertMany(collection, encrypted);
          },
        ),

      updateOne: (collection, filter, update, ...rest) =>
        encryptUpdate(collection, filter, update).then((encrypted) => {
          encLog.debug(`Encrypting updateOne for ${collection}`);
          return methods.updateOne(collection, filter, encrypted, ...rest);
        }),

      updateMany: (collection, filter, update, ...rest) =>
        encryptUpdate(collection, filter, update).then((encrypted) => {
          encLog.debug(`Encrypting updateMany for ${collection}`);
          return methods.updateMany(collection, filter, encrypted, ...rest);
        }),

      findOneAndUpdate: (collection, filter, update, ...rest) =>
        encryptUpdate(collection, filter, update).then((encrypted) => {
          encLog.debug(`Encrypting findOneAndUpdate for ${collection}`);
          return methods.findOneAndUpdate(
            collection,
            filter,
            encrypted,
            ...rest,
          );
        }),

      findOneAndReplace: (collection, filter, replacement, ...rest) =>
        encryptFields(collection, replacement, filter).then((encrypted) => {
          encLog.debug(`Encrypting findOneAndReplace for ${collection}`);
          return methods.findOneAndReplace(
            collection,
            filter,
            encrypted,
            ...rest,
          );
        }),

      bulkWrite: (collection, operations) =>
        Promise.all(operations.map((op) => encryptBulkOp(collection, op))).then(
          (encrypted) => {
            encLog.debug(
              `Encrypting bulkWrite (${operations.length} ops) ` +
                `for ${collection}`,
            );
            return methods.bulkWrite(collection, encrypted);
          },
        ),
    };
  };

  log.info('Storage encryption wrapper initialized');

  return (...args) =>
    storageFactory(...args).then((storage) => ({
      ...storage,
      perRequest: wrapPerRequest(storage.perRequest),
    }));
};
