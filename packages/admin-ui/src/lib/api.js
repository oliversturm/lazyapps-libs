const jsonFetch = (url, options) =>
  fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  }).then((r) => {
    if (r.status === 204) return null;
    return r.json().then((body) => (r.ok ? body : Promise.reject(body)));
  });

export const createAdminClient = (
  commandProcessorUrl,
  readModelServiceUrls,
) => ({
  // Command processor endpoints

  startReplay: (readModel, fromTimestamp, toTimestamp, targetServiceId) =>
    jsonFetch(`${commandProcessorUrl}/api/admin/startReplay`, {
      method: 'POST',
      body: JSON.stringify({
        readModel,
        fromTimestamp,
        toTimestamp,
        ...(targetServiceId && { targetServiceId }),
      }),
    }),

  getReplayStatus: (readModel) =>
    jsonFetch(`${commandProcessorUrl}/api/admin/replayStatus/${readModel}`),

  cancelReplay: (readModel) =>
    jsonFetch(`${commandProcessorUrl}/api/admin/cancelReplay`, {
      method: 'POST',
      body: JSON.stringify({ readModel }),
    }),

  // Read model service endpoints

  getStatus: (serviceUrl) => jsonFetch(`${serviceUrl}/admin/status`),

  getReadModels: (serviceUrl) => jsonFetch(`${serviceUrl}/admin/readmodels`),

  prepareReplay: (serviceUrl, readModel, options) =>
    jsonFetch(`${serviceUrl}/admin/replay/${readModel}/prepare`, {
      method: 'POST',
      body: JSON.stringify(options),
    }),

  getReplayReadModelStatus: (serviceUrl, readModel) =>
    jsonFetch(`${serviceUrl}/admin/replay/${readModel}/status`),

  createBackup: (serviceUrl, readModel) =>
    jsonFetch(`${serviceUrl}/admin/backup/${readModel}`, {
      method: 'POST',
      body: '{}',
    }),

  listBackups: (serviceUrl, readModel) =>
    jsonFetch(`${serviceUrl}/admin/backups/${readModel}`),

  deleteBackup: (serviceUrl, backupId) =>
    jsonFetch(`${serviceUrl}/admin/backup/${backupId}`, {
      method: 'DELETE',
    }),

  // Helpers

  getServiceUrl: (serviceName) => readModelServiceUrls[serviceName],

  getServiceNames: () => Object.keys(readModelServiceUrls),

  findServiceForReadModel: (readModelName) =>
    Promise.all(
      Object.entries(readModelServiceUrls).map(([name, url]) =>
        jsonFetch(`${url}/admin/readmodels`)
          .then((models) =>
            models.find((m) => m.name === readModelName) ? { name, url } : null,
          )
          .catch(() => null),
      ),
    ).then((results) => results.find((r) => r !== null) || null),
});
