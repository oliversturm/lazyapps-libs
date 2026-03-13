<script>
  import { getContext } from 'svelte';
  import BackupList from '$lib/components/BackupList.svelte';

  let { data } = $props();

  const api = getContext('api');

  let backups = $state([]);
  let loading = $state(true);
  let creating = $state(false);
  let error = $state(null);

  const loadBackups = () => {
    loading = true;
    error = null;
    api
      .listBackups('', data.endpointName, data.name)
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

  const handleCreate = () => {
    creating = true;
    error = null;
    api
      .createBackup('', data.endpointName, data.name)
      .then(() => {
        creating = false;
        loadBackups();
      })
      .catch((err) => {
        error = err.error || String(err);
        creating = false;
      });
  };

  const handleDelete = (backupId) => {
    error = null;
    api
      .deleteBackup('', backupId, data.endpointName, data.name)
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
    href="/readmodels/{data.name}?service={data.service}"
    class="text-sm text-blue-600 hover:underline">&larr; Back to {data.name}</a
  >
</div>

<div class="flex items-center justify-between mb-6">
  <div>
    <h1 class="text-2xl font-bold text-gray-900">Backups: {data.name}</h1>
    <p class="text-sm text-gray-500">Service: {data.service}</p>
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

{#if loading}
  <p class="text-gray-500">Loading backups...</p>
{:else}
  <div class="bg-white rounded-lg shadow p-6">
    <BackupList {backups} ondelete={handleDelete} />
  </div>
{/if}
