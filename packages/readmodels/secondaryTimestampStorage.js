import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { getLogger } from '@lazyapps/logger';

export const filesystemTimestampStorage = (basePath) => {
  const pathFor = (readModelName) =>
    join(basePath, `${readModelName}.timestamp`);

  return {
    writeTimestamp: (readModelName, timestamp) => {
      const filePath = pathFor(readModelName);
      return mkdir(dirname(filePath), { recursive: true }).then(() =>
        writeFile(filePath, String(timestamp), 'utf8'),
      );
    },

    readTimestamp: (readModelName) => {
      const filePath = pathFor(readModelName);
      return readFile(filePath, 'utf8')
        .then((content) => {
          const parsed = Number(content.trim());
          return Number.isFinite(parsed) ? parsed : 0;
        })
        .catch(() => 0);
    },
  };
};

export const readTimestampFromBoth =
  (primaryStorage, secondaryStorage) => (readModels) => {
    const log = getLogger('RM/Timestamp', 'INIT');
    const rmNames = Object.keys(readModels);

    return primaryStorage
      .readLastProjectedEventTimestamps(readModels)
      .then(() => {
        if (!secondaryStorage) return;
        return Promise.all(
          rmNames.map((name) =>
            secondaryStorage.readTimestamp(name).then((secondaryTs) => {
              const primaryTs =
                readModels[name].lastProjectedEventTimestamp || 0;
              if (secondaryTs > primaryTs) {
                log.warn(
                  `Read model '${name}': secondary timestamp (${secondaryTs}) ` +
                    `> primary (${primaryTs}) — using secondary`,
                );
                readModels[name].lastProjectedEventTimestamp = secondaryTs;
              }
            }),
          ),
        );
      });
  };
