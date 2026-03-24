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

  const handleRestore = (backupId) => {
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
      disabled={creating}
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

{#if readModel?.state === 'stopped'}
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
    <BackupList {backups} ondelete={handleDelete} onrestore={handleRestore} />
  </div>
{/if}
