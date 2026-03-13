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

  startReplay: (readModel, fromTimestamp, toTimestamp, targetEndpointName) =>
    jsonFetch(`${commandProcessorUrl}/api/admin/startReplay`, {
      method: 'POST',
      body: JSON.stringify({
        readModel,
        fromTimestamp,
        toTimestamp,
        ...(targetEndpointName && { targetEndpointName }),
      }),
    }),

  getReplayStatus: (endpointName, readModel) =>
    jsonFetch(
      `${commandProcessorUrl}/api/admin/replayStatus` +
        `/${endpointName}/${readModel}`,
    ),

  cancelReplay: (readModel) =>
    jsonFetch(`${commandProcessorUrl}/api/admin/cancelReplay`, {
      method: 'POST',
      body: JSON.stringify({ readModel }),
    }),

  // Read model service endpoints

  getStatus: (serviceUrl) => jsonFetch(`${serviceUrl}/admin/status`),

  getReadModels: (serviceUrl) => jsonFetch(`${serviceUrl}/admin/readmodels`),

  prepareReplay: (serviceUrl, endpointName, readModel, options) =>
    jsonFetch(
      `${serviceUrl}/admin/replay/${endpointName}/${readModel}/prepare`,
      {
        method: 'POST',
        body: JSON.stringify(options),
      },
    ),

  getReplayReadModelStatus: (serviceUrl, endpointName, readModel) =>
    jsonFetch(`${serviceUrl}/admin/replay/${endpointName}/${readModel}/status`),

  createBackup: (serviceUrl, endpointName, readModel) =>
    jsonFetch(`${serviceUrl}/admin/backup/${endpointName}/${readModel}`, {
      method: 'POST',
      body: '{}',
    }),

  listBackups: (serviceUrl, endpointName, readModel) =>
    jsonFetch(`${serviceUrl}/admin/backups/${endpointName}/${readModel}`),

  deleteBackup: (serviceUrl, backupId, endpointName, readModelName) =>
    jsonFetch(
      `${serviceUrl}/admin/backup/${backupId}` +
        `?readModelName=${encodeURIComponent(readModelName)}` +
        `&endpointName=${encodeURIComponent(endpointName)}`,
      {
        method: 'DELETE',
      },
    ),

  // Helpers

  getServiceUrl: (serviceName) => readModelServiceUrls[serviceName],

  getServiceNames: () => Object.keys(readModelServiceUrls),

  findServiceForReadModel: (readModelName) =>
    Promise.all(
      Object.entries(readModelServiceUrls).map(([name, url]) =>
        jsonFetch(`${url}/admin/readmodels`)
          .then((models) => {
            const found = models.find((m) => m.name === readModelName);
            return found
              ? { name, url, endpointName: found.endpointName }
              : null;
          })
          .catch(() => null),
      ),
    ).then((results) => results.find((r) => r !== null) || null),
});
