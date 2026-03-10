import { getLogger } from '@lazyapps/logger';

const clearReplayInProgress = (storage, readModelName) =>
  storage
    .perRequest('replay')
    .updateOne(
      'readmodel.state',
      { name: readModelName },
      { $unset: { replayInProgress: '', preReplayBackupId: '' } },
    );

const getPreReplayBackupId = (storage, readModelName) =>
  storage
    .perRequest('replay')
    .find('readmodel.state', { name: readModelName })
    .toArray()
    .then((docs) => docs[0]?.preReplayBackupId || null);

const sendBulkRefreshNotification = (context, correlationId, readModelName) => {
  const rm = context.readModels[readModelName];
  if (!rm || !rm.resolvers) return Promise.resolve();
  const changeNotif = context.changeNotification(correlationId);
  return Object.keys(rm.resolvers).reduce(
    (chain, resolverName) =>
      chain.then(() =>
        changeNotif.sendChangeNotification(
          changeNotif.createChangeInfo(readModelName, resolverName, 'all'),
        ),
      ),
    Promise.resolve(),
  );
};

export const createReadModelReplayHandler = (context) => {
  const handleReplayComplete = (readModel, correlationId) => {
    const log = getLogger('RM/Replay', correlationId || 'SYS');
    log.info(`Replay events done for ${readModel}, finalizing`);
    context.projectionHandler.clearReadModelReplayState(readModel);
    return clearReplayInProgress(context.storage, readModel).then(() =>
      sendBulkRefreshNotification(
        context,
        correlationId || 'replay',
        readModel,
      ),
    );
  };

  const handleReplayCancelled = (readModel, correlationId) => {
    const log = getLogger('RM/Replay', correlationId || 'SYS');
    log.info(`Replay cancelled for ${readModel}, restoring pre-replay backup`);
    return getPreReplayBackupId(context.storage, readModel)
      .then((backupId) =>
        backupId && context.backup
          ? context.backup.restoreBackup(
              correlationId || 'replay',
              readModel,
              backupId,
            )
          : Promise.resolve(),
      )
      .then(() => {
        context.projectionHandler.clearReadModelReplayState(readModel);
        return clearReplayInProgress(context.storage, readModel);
      });
  };

  return { handleReplayComplete, handleReplayCancelled };
};
