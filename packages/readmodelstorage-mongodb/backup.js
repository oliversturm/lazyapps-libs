import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getLogger } from '@lazyapps/logger';

const validatePath = (basePath, targetPath) => {
  const resolved = resolve(targetPath);
  const resolvedBase = resolve(basePath);
  if (!resolved.startsWith(resolvedBase + '/') && resolved !== resolvedBase) {
    throw new Error('Path traversal detected');
  }
  return resolved;
};

const execFileAsync = promisify(execFile);

const normalizeUri = (uri) => {
  const qIdx = uri.indexOf('?');
  if (qIdx === -1) return uri;
  const beforeQ = uri.substring(0, qIdx);
  if (beforeQ.endsWith('/')) return uri;
  return beforeQ + '/' + uri.substring(qIdx);
};

const formatTimestamp = (ts) => new Date(ts).toISOString().replace(/:/g, '-');

const generateBackupId = (readModelName, timestamp) =>
  `${readModelName}__${formatTimestamp(timestamp)}`;

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

const dumpBson = (command, url, database, collectionNames, backupDir) =>
  collectionNames.reduce(
    (chain, col) =>
      chain.then(() =>
        execFileAsync(command[0], [
          ...command.slice(1),
          `--uri=${url}`,
          `--db=${database}`,
          `--collection=${col}`,
          `--out=${backupDir}`,
          '--gzip',
        ]),
      ),
    Promise.resolve(),
  );

const dumpJson = (command, url, database, collectionNames, backupDir) =>
  collectionNames.reduce(
    (chain, col) =>
      chain.then(() =>
        execFileAsync(command[0], [
          ...command.slice(1),
          `--uri=${url}`,
          `--db=${database}`,
          `--collection=${col}`,
          `--out=${join(backupDir, `${col}.json`)}`,
          '--jsonArray',
        ]),
      ),
    Promise.resolve(),
  );

const restoreBson = (command, url, database, collectionNames, backupDir) =>
  collectionNames.reduce(
    (chain, col) =>
      chain.then(() =>
        execFileAsync(command[0], [
          ...command.slice(1),
          `--uri=${url}`,
          '--drop',
          '--gzip',
          `--nsInclude=${database}.${col}`,
          backupDir,
        ]),
      ),
    Promise.resolve(),
  );

const restoreJson = (command, url, database, collectionNames, backupDir) =>
  collectionNames.reduce(
    (chain, col) =>
      chain.then(() =>
        execFileAsync(command[0], [
          ...command.slice(1),
          `--uri=${url}`,
          `--db=${database}`,
          `--collection=${col}`,
          '--drop',
          '--jsonArray',
          `--file=${join(backupDir, `${col}.json`)}`,
        ]),
      ),
    Promise.resolve(),
  );

export const backup =
  ({
    backupPath,
    format = 'bson',
    mongodumpCommand = ['mongodump'],
    mongorestoreCommand = ['mongorestore'],
    mongoexportCommand = ['mongoexport'],
    mongoimportCommand = ['mongoimport'],
    toolBackupPath,
  } = {}) =>
  (storage) => {
    const { url: rawUrl, database } = storage.__connectionInfo__;
    const url = normalizeUri(rawUrl);
    const effectiveToolBackupPath = toolBackupPath || backupPath;

    return {
      createBackup: (correlationId, readModelName, collectionNames) => {
        const log = getLogger('RM/Backup', correlationId);
        const timestamp = Date.now();
        const backupId = generateBackupId(readModelName, timestamp);
        const backupDir = join(backupPath, readModelName, backupId);

        log.debug(`Creating backup ${backupId} (format: ${format})`);

        const toolBackupDir = join(
          effectiveToolBackupPath,
          readModelName,
          backupId,
        );

        return mkdir(backupDir, { recursive: true })
          .then(() =>
            storage
              .perRequest(correlationId)
              .find('readmodel.state', { name: readModelName })
              .toArray(),
          )
          .then((docs) => {
            const eventTimestamp = docs[0]?.lastProjectedEventTimestamp || 0;

            const dumpPromise =
              format === 'json'
                ? dumpJson(
                    mongoexportCommand,
                    url,
                    database,
                    collectionNames,
                    toolBackupDir,
                  )
                : dumpBson(
                    mongodumpCommand,
                    url,
                    database,
                    collectionNames,
                    toolBackupDir,
                  );

            return dumpPromise.then(() => {
              const metadata = {
                backupId,
                readModelName,
                timestamp,
                eventTimestamp,
                collections: collectionNames,
                format,
                database,
              };
              return writeFile(
                join(backupDir, 'metadata.json'),
                JSON.stringify(metadata, null, 2),
              ).then(() => {
                log.debug(`Backup ${backupId} created at ${backupDir}`);
                return { backupId, timestamp, eventTimestamp };
              });
            });
          });
      },

      listBackups: (readModelName) => {
        const rmDir = join(backupPath, readModelName);
        return readdir(rmDir)
          .catch(() => [])
          .then((entries) =>
            Promise.all(
              entries
                .sort()
                .reverse()
                .map((entry) =>
                  readFile(join(rmDir, entry, 'metadata.json'), 'utf8')
                    .then(JSON.parse)
                    .catch(() => null),
                ),
            ),
          )
          .then((results) => results.filter(Boolean));
      },

      restoreBackup: (correlationId, readModelName, backupId) => {
        const log = getLogger('RM/Backup', correlationId);
        const backupDir = join(backupPath, readModelName, backupId);
        validatePath(backupPath, backupDir);
        const toolBackupDir = join(
          effectiveToolBackupPath,
          readModelName,
          backupId,
        );

        log.debug(`Restoring backup ${backupId} for ${readModelName}`);

        return readFile(join(backupDir, 'metadata.json'), 'utf8')
          .then(JSON.parse)
          .then((metadata) => {
            const [restoreFn, restoreCmd] =
              metadata.format === 'json'
                ? [restoreJson, mongoimportCommand]
                : [restoreBson, mongorestoreCommand];
            return restoreFn(
              restoreCmd,
              url,
              database,
              metadata.collections,
              toolBackupDir,
            ).then(() =>
              storage.updateLastProjectedEventTimestamps(
                correlationId,
                [readModelName],
                metadata.eventTimestamp,
              ),
            );
          })
          .then(() => {
            log.debug(`Backup ${backupId} restored`);
          });
      },

      deleteBackup: (correlationId, backupId) => {
        const log = getLogger('RM/Backup', correlationId);

        return readdir(backupPath)
          .then((rmDirs) =>
            rmDirs.reduce(
              (chain, rmDir) =>
                chain.then((found) => {
                  if (found) return found;
                  const candidate = join(backupPath, rmDir, backupId);
                  validatePath(backupPath, candidate);
                  return readFile(join(candidate, 'metadata.json'), 'utf8')
                    .then(() => candidate)
                    .catch(() => null);
                }),
              Promise.resolve(null),
            ),
          )
          .then((dir) => {
            if (!dir) return;
            log.debug(`Deleting backup ${backupId}`);
            return rm(dir, { recursive: true, force: true });
          })
          .then(() => {
            log.debug(`Backup ${backupId} deleted`);
          });
      },

      clearCollections: (correlationId, readModelName, collectionNames) => {
        const log = getLogger('RM/Backup', correlationId);
        log.debug(`Clearing collections for ${readModelName}`);

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
          );
      },

      cleanupBackups: (readModelName, retentionPolicy) => {
        const log = getLogger('RM/Backup', 'cleanup');
        const rmDir = join(backupPath, readModelName);

        return readdir(rmDir)
          .catch(() => [])
          .then((entries) =>
            Promise.all(
              entries
                .sort()
                .reverse()
                .map((entry) =>
                  readFile(join(rmDir, entry, 'metadata.json'), 'utf8')
                    .then(JSON.parse)
                    .catch(() => null),
                ),
            ),
          )
          .then((backups) => backups.filter(Boolean))
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

            if (!toDelete.length) return;

            log.debug(
              `Cleaning up ${toDelete.length} old backups for ${readModelName}`,
            );

            return toDelete.reduce(
              (chain, b) =>
                chain.then(() =>
                  rm(join(rmDir, b.backupId), {
                    recursive: true,
                    force: true,
                  }),
                ),
              Promise.resolve(),
            );
          });
      },
    };
  };

export const __testing__ = {
  formatTimestamp,
  generateBackupId,
  parseMaxAge,
  normalizeUri,
  dumpBson,
  dumpJson,
  restoreBson,
  restoreJson,
  validatePath,
};
