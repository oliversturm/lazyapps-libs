import { getLogger } from '@lazyapps/logger';

const generateBackupId = (readModelName) =>
  `backup_${Date.now()}_${readModelName}`;

const parseMaxAge = (maxAge) => {
  const match = maxAge.match(/^(\d+)([dhm])$/);
  if (!match) return 0;
  const value = parseInt(match[1], 10);
  const unit = match[2];
  if (unit === 'd') return value * 24 * 60 * 60 * 1000;
  if (unit === 'h') return value * 60 * 60 * 1000;
  if (unit === 'm') return value * 60 * 1000;
  return 0;
};

export const mongoBackup =
  ({ metadataCollection = 'admin.backups' } = {}) =>
  (storage) => ({
    createBackup: (correlationId, readModelName, collectionNames) => {
      const log = getLogger('RM/Backup', correlationId);
      const backupId = generateBackupId(readModelName);
      const timestamp = Date.now();

      log.debug(
        `Creating backup ${backupId} for ${readModelName} (collections: ${JSON.stringify(collectionNames)})`,
      );

      return collectionNames
        .reduce(
          (chain, colName) =>
            chain.then(() =>
              storage.copyCollection(
                correlationId,
                colName,
                `${backupId}_${colName}`,
              ),
            ),
          Promise.resolve(),
        )
        .then(() =>
          storage
            .perRequest(correlationId)
            .find('readmodel.state', { name: readModelName })
            .toArray(),
        )
        .then((docs) => {
          const eventTimestamp = docs[0]?.lastProjectedEventTimestamp || 0;
          const metadata = {
            backupId,
            readModelName,
            timestamp,
            eventTimestamp,
            collections: collectionNames,
          };
          return storage
            .perRequest(correlationId)
            .insertOne(metadataCollection, metadata)
            .then(() => {
              log.debug(`Backup ${backupId} created successfully`);
              return { backupId, timestamp, eventTimestamp };
            });
        });
    },

    listBackups: (readModelName) =>
      storage
        .perRequest('backup')
        .find(metadataCollection, { readModelName })
        .sort({ timestamp: -1 })
        .toArray()
        .then((docs) => docs.map(({ _id, ...rest }) => rest)),

    restoreBackup: (correlationId, readModelName, backupId) => {
      const log = getLogger('RM/Backup', correlationId);
      log.debug(`Restoring backup ${backupId} for ${readModelName}`);

      return storage
        .perRequest(correlationId)
        .find(metadataCollection, { backupId })
        .toArray()
        .then((docs) => {
          if (!docs.length)
            return Promise.reject(new Error(`Backup ${backupId} not found`));
          return docs[0];
        })
        .then((metadata) =>
          metadata.collections
            .reduce(
              (chain, colName) =>
                chain.then(() =>
                  storage
                    .dropCollection(correlationId, colName)
                    .then(() =>
                      storage.copyCollection(
                        correlationId,
                        `${backupId}_${colName}`,
                        colName,
                      ),
                    ),
                ),
              Promise.resolve(),
            )
            .then(() =>
              storage.updateLastProjectedEventTimestamps(
                correlationId,
                [readModelName],
                metadata.eventTimestamp,
              ),
            )
            .then(() => {
              log.debug(`Backup ${backupId} restored successfully`);
            }),
        );
    },

    deleteBackup: (correlationId, backupId) => {
      const log = getLogger('RM/Backup', correlationId);
      log.debug(`Deleting backup ${backupId}`);

      return storage
        .perRequest(correlationId)
        .find(metadataCollection, { backupId })
        .toArray()
        .then((docs) => {
          if (!docs.length) return Promise.resolve();
          const metadata = docs[0];
          return metadata.collections
            .reduce(
              (chain, colName) =>
                chain.then(() =>
                  storage.dropCollection(
                    correlationId,
                    `${backupId}_${colName}`,
                  ),
                ),
              Promise.resolve(),
            )
            .then(() =>
              storage
                .perRequest(correlationId)
                .deleteOne(metadataCollection, { backupId }),
            )
            .then(() => {
              log.debug(`Backup ${backupId} deleted`);
            });
        });
    },

    clearCollections: (correlationId, readModelName, collectionNames) => {
      const log = getLogger('RM/Backup', correlationId);
      log.debug(
        `Clearing collections for ${readModelName}: ${JSON.stringify(collectionNames)}`,
      );

      return collectionNames
        .reduce(
          (chain, colName) =>
            chain.then(() => storage.dropCollection(correlationId, colName)),
          Promise.resolve(),
        )
        .then(() =>
          storage.updateLastProjectedEventTimestamps(
            correlationId,
            [readModelName],
            0,
          ),
        )
        .then(() => {
          log.debug(`Collections cleared for ${readModelName}`);
        });
    },

    cleanupBackups: (readModelName, retentionPolicy) => {
      const log = getLogger('RM/Backup', 'cleanup');

      return storage
        .perRequest('cleanup')
        .find(metadataCollection, { readModelName })
        .sort({ timestamp: -1 })
        .toArray()
        .then((backups) => {
          let toDelete = [];

          if (
            retentionPolicy.maxCount &&
            backups.length > retentionPolicy.maxCount
          ) {
            toDelete = backups.slice(retentionPolicy.maxCount);
          }

          if (retentionPolicy.maxAge) {
            const cutoff = Date.now() - parseMaxAge(retentionPolicy.maxAge);
            const aged = backups.filter((b) => b.timestamp < cutoff);
            toDelete = [...new Set([...toDelete, ...aged])];
          }

          if (!toDelete.length) return Promise.resolve();

          log.debug(
            `Cleaning up ${toDelete.length} old backups for ${readModelName}`,
          );

          return toDelete.reduce(
            (chain, backup) =>
              chain.then(() =>
                backup.collections
                  .reduce(
                    (innerChain, colName) =>
                      innerChain.then(() =>
                        storage.dropCollection(
                          'cleanup',
                          `${backup.backupId}_${colName}`,
                        ),
                      ),
                    Promise.resolve(),
                  )
                  .then(() =>
                    storage
                      .perRequest('cleanup')
                      .deleteOne(metadataCollection, {
                        backupId: backup.backupId,
                      }),
                  ),
              ),
            Promise.resolve(),
          );
        });
    },
  });

export const __testing__ = { generateBackupId, parseMaxAge };
