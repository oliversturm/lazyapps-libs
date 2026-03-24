<script>
  import { getContext } from 'svelte';
  import BackupList from '$lib/components/BackupList.svelte';

  let { data } = $props();

  const api = getContext('api');
  const statusStore = getContext('statusStore');

  let backups = $state([]);
  let loading = $state(true);
  let creating = $state(false);
  let error = $state(null);

  const loadBackups = () => {
    loading = true;
    error = null;
    api
      .listBackups(data.ep, data.rm)
      .then((result) => {
        backups = result;
        loading = false;
      })
      .catch((err) => {
        error = err.error || String(err);
        loading = false;
      });
  };

  $effect(() => {
    loadBackups();
  });

  // When backup progress returns to idle while we're waiting for a
  // create to finish, refresh the list to pick up the new entry.
  let waitingForBackup = $state(false);

  $effect(() => {
    if (!waitingForBackup) return;
    const rm = $statusStore.readModels.find(
      (rm) => rm.name === data.rm && rm.endpointName === data.ep,
    );
    if (rm?.backupProgress?.state === 'idle') {
      waitingForBackup = false;
      creating = false;
      loadBackups();
    }
  });

  const handleCreate = () => {
    creating = true;
    waitingForBackup = true;
    error = null;
    api.createBackup(data.ep, data.rm).catch((err) => {
      error = err.error || String(err);
      creating = false;
      waitingForBackup = false;
    });
  };

  const handleDelete = (backupId) => {
    error = null;
    api
      .deleteBackup(data.ep, data.rm, backupId)
      .then(() => {
        loadBackups();
      })
      .catch((err) => {
        error = err.error || String(err);
      });
  };

  let readModel = $derived(
    $statusStore.readModels.find(
      (rm) => rm.name === data.rm && rm.endpointName === data.ep,
    ) || null,
  );

  const handleActivate = () => {
    api.activate(data.ep, data.rm).catch((err) => {
      error = err.error || String(err);
    });
  };

  let restoreConfirmBackupId = $state(null);

  const handleRestoreRequest = (backupId) => {
    restoreConfirmBackupId = backupId;
  };

  const handleRestoreConfirm = () => {
    const backupId = restoreConfirmBackupId;
    restoreConfirmBackupId = null;
    error = null;
    api
      .restoreBackup(data.ep, data.rm, backupId)
      .then(() => {
        loadBackups();
      })
      .catch((err) => {
        error = err.error || String(err);
      });
  };

  const handleRestoreCancel = () => {
    restoreConfirmBackupId = null;
  };
</script>

<div class="mb-4">
  <a
    href="/readmodel/{data.ep}/{data.rm}"
    class="text-sm text-blue-600 hover:underline">&larr; Back to {data.rm}</a
  >
</div>

<div class="flex items-center justify-between mb-6">
  <div>
    <h1 class="text-2xl font-bold text-gray-900">Backups: {data.rm}</h1>
    <p class="text-sm text-gray-500">Endpoint: {data.ep}</p>
  </div>
  <div class="flex space-x-2">
    <button
      onclick={handleCreate}
      disabled={creating || readModel?.state === 'invalid'}
      class="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
    >
      {creating ? 'Creating...' : 'Create Backup'}
    </button>
    <button
      onclick={loadBackups}
      class="px-3 py-2 bg-gray-100 text-gray-700 text-sm rounded hover:bg-gray-200"
    >
      Refresh
    </button>
  </div>
</div>

{#if error}
  <div
    class="mb-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700"
  >
    {error}
  </div>
{/if}

{#if readModel?.state === 'invalid'}
  <div class="mb-4 p-4 bg-red-50 border border-red-300 rounded-lg">
    <h3 class="text-sm font-semibold text-red-800 mb-1">Invalid State</h3>
    <p class="text-sm text-red-700">
      This read model is in an invalid state. Backup operations are disabled
      because the data may be unreliable. Manual database intervention is
      required to recover. Contact your administrator.
    </p>
  </div>
{:else if readModel?.state === 'stopped'}
  <div class="mb-4 p-3 bg-amber-50 border border-amber-200 rounded flex items-center justify-between">
    <span class="text-sm text-amber-700">Read model is stopped.</span>
    <button onclick={handleActivate} class="px-3 py-1.5 bg-green-600 text-white text-sm rounded hover:bg-green-700">
      Activate
    </button>
  </div>
{/if}

{#if loading}
  <p class="text-gray-500">Loading backups...</p>
{:else}
  <div class="bg-white rounded-lg shadow p-6">
    <BackupList
      {backups}
      ondelete={readModel?.state === 'invalid' ? undefined : handleDelete}
      onrestore={readModel?.state === 'invalid' ? undefined : handleRestoreRequest}
    />
  </div>
{/if}

{#if restoreConfirmBackupId}
  <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
    <div class="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 p-6">
      <h3 class="text-lg font-semibold text-gray-900 mb-2">Confirm Restore</h3>
      <div class="mb-4 p-3 bg-amber-50 border border-amber-300 rounded">
        <p class="text-sm text-amber-800 font-medium mb-1">Warning: Standalone restore</p>
        <p class="text-sm text-amber-700">
          Standalone backup restore will put this read model into a state
          requiring a replay to become consistent. To restore safely, use
          Replay from Backup on the replay page instead.
        </p>
      </div>
      <p class="text-sm text-gray-600 mb-4">
        Restore backup <span class="font-mono">{restoreConfirmBackupId}</span>?
      </p>
      <div class="flex justify-end space-x-3">
        <button
          onclick={handleRestoreCancel}
          class="px-4 py-2 text-sm text-gray-700 bg-gray-100 rounded hover:bg-gray-200"
        >
          Cancel
        </button>
        <button
          onclick={handleRestoreConfirm}
          class="px-4 py-2 text-sm text-white bg-amber-600 rounded hover:bg-amber-700"
        >
          Restore Anyway
        </button>
      </div>
    </div>
  </div>
{/if}
