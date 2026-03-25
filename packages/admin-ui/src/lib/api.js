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

export const createAdminClient = () => ({
  startReplay: (ep, rm, options) =>
    jsonFetch(`/admin/replay/start/${ep}/${rm}`, {
      method: 'POST',
      body: JSON.stringify(options),
    }),

  cancelReplay: (ep, rm, options) =>
    jsonFetch(`/admin/replay/cancel/${ep}/${rm}`, {
      method: 'POST',
      body: JSON.stringify(options),
    }),

  createBackup: (ep, rm) =>
    jsonFetch(`/admin/backup/create/${ep}/${rm}`, {
      method: 'POST',
      body: '{}',
    }),

  cancelBackup: (ep, rm) =>
    jsonFetch(`/admin/backup/cancel/${ep}/${rm}`, {
      method: 'POST',
      body: '{}',
    }),

  restoreBackup: (ep, rm, backupId) =>
    jsonFetch(`/admin/backup/restore/${ep}/${rm}`, {
      method: 'POST',
      body: JSON.stringify({ backupId }),
    }),

  deleteBackup: (ep, rm, backupId) =>
    jsonFetch(`/admin/backup/delete/${ep}/${rm}`, {
      method: 'POST',
      body: JSON.stringify({ backupId }),
    }),

  listBackups: (ep, rm) => jsonFetch(`/admin/backup/list/${ep}/${rm}`),

  activateAll: () =>
    jsonFetch('/admin/readmodel/activate-all', {
      method: 'POST',
      body: '{}',
    }),

  activate: (ep, rm) =>
    jsonFetch(`/admin/readmodel/activate/${ep}/${rm}`, {
      method: 'POST',
      body: '{}',
    }),

  stop: (ep, rm) =>
    jsonFetch(`/admin/readmodel/stop/${ep}/${rm}`, {
      method: 'POST',
      body: '{}',
    }),

  reset: (ep, rm) =>
    jsonFetch(`/admin/readmodel/reset/${ep}/${rm}`, {
      method: 'POST',
      body: '{}',
    }),

  replayPreflight: (ep, rm) => jsonFetch(`/admin/replay/preflight/${ep}/${rm}`),

  getConfig: () => jsonFetch('/admin/config'),

  validateFilter: (filterString) =>
    jsonFetch('/admin/validate-filter', {
      method: 'POST',
      body: JSON.stringify({ filterString }),
    }),

  activateWithoutCatchup: (ep, rm) =>
    jsonFetch(`/admin/readmodel/activate/${ep}/${rm}`, {
      method: 'POST',
      body: JSON.stringify({ skipCatchup: true }),
    }),

  dismissInvalid: (ep, rm) =>
    jsonFetch(`/admin/readmodel/dismiss-invalid/${ep}/${rm}`, {
      method: 'POST',
      body: '{}',
    }),

  refreshStatus: () => jsonFetch('/admin/readmodel/status'),

  getCommandProcessorStatus: () => jsonFetch('/admin/commandprocessor/status'),
});
