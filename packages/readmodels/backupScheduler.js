import { getLogger } from '@lazyapps/logger';

const parseInterval = (interval) => {
  const match = interval.match(/^(\d+)([dhm])$/);
  if (!match) return 0;
  const value = parseInt(match[1], 10);
  const unit = match[2];
  if (unit === 'd') return value * 24 * 60 * 60 * 1000;
  if (unit === 'h') return value * 60 * 60 * 1000;
  if (unit === 'm') return value * 60 * 1000;
  return 0;
};

export const createBackupScheduler = (context, config) => {
  const log = getLogger('RM/BackupSched', 'SYS');
  const { interval, retention, readModels: targetReadModels } = config;

  const intervalMs = parseInterval(interval);
  let timer = null;

  const getCollectionNames = (rmName) => {
    const rm = context.readModels[rmName];
    return rm && rm.collections ? rm.collections : [rmName];
  };

  const runBackups = () => {
    log.debug('Running scheduled backups');
    return (targetReadModels || Object.keys(context.readModels))
      .reduce(
        (chain, rmName) =>
          chain
            .then(() =>
              context.backup.createBackup(
                'backup-sched',
                rmName,
                getCollectionNames(rmName),
              ),
            )
            .then(() =>
              retention
                ? context.backup.cleanupBackups(rmName, retention)
                : Promise.resolve(),
            )
            .catch((err) => {
              log.error(`Scheduled backup failed for ${rmName}: ${err}`);
            }),
        Promise.resolve(),
      )
      .then(() => {
        log.debug('Scheduled backups complete');
      });
  };

  const start = () => {
    if (!intervalMs) {
      log.error(`Invalid backup interval: ${interval}`);
      return;
    }
    log.info(
      `Starting backup scheduler (interval: ${interval}, targets: ${JSON.stringify(targetReadModels || 'all')})`,
    );
    timer = setInterval(runBackups, intervalMs);
  };

  const stop = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
      log.info('Backup scheduler stopped');
    }
  };

  return { start, stop, runBackups };
};

export const __testing__ = { parseInterval };
