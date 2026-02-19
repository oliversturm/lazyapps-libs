<script>
  import { getContext } from 'svelte';
  import StatusBadge from '$lib/components/StatusBadge.svelte';

  const api = getContext('api');
  const config = getContext('config');

  let readModels = $state([]);
  let loading = $state(true);

  const loadReadModels = () => {
    loading = true;
    Promise.all(
      Object.entries(config.readModelServices).map(([serviceName, url]) =>
        api
          .getReadModels(url)
          .then((models) =>
            models.map((m) => ({ ...m, serviceName, serviceUrl: url })),
          )
          .catch(() => []),
      ),
    ).then((results) => {
      readModels = results.flat();
      loading = false;
    });
  };

  $effect(() => {
    loadReadModels();
  });

  const formatTimestamp = (ts) => {
    if (!ts) return 'N/A';
    return new Date(ts).toLocaleString();
  };
</script>

<div class="flex items-center justify-between mb-6">
  <h1 class="text-2xl font-bold text-gray-900">Read Models</h1>
  <button
    onclick={loadReadModels}
    class="px-3 py-1.5 bg-gray-100 text-gray-700 text-sm rounded hover:bg-gray-200"
  >
    Refresh
  </button>
</div>

{#if loading}
  <p class="text-gray-500">Loading read models...</p>
{:else if readModels.length === 0}
  <p class="text-gray-500">No read models found.</p>
{:else}
  <div class="bg-white shadow rounded-lg overflow-hidden">
    <table class="min-w-full divide-y divide-gray-200">
      <thead class="bg-gray-50">
        <tr>
          <th
            class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase"
            >Name</th
          >
          <th
            class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase"
            >Service</th
          >
          <th
            class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase"
            >Last Projected</th
          >
          <th
            class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase"
            >Status</th
          >
          <th
            class="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase"
            >Collections</th
          >
          <th
            class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase"
            >Actions</th
          >
        </tr>
      </thead>
      <tbody class="bg-white divide-y divide-gray-200">
        {#each readModels as rm}
          <tr>
            <td class="px-6 py-4 text-sm font-medium text-gray-900">
              <a
                href="/readmodels/{rm.name}?service={rm.serviceName}"
                class="text-blue-600 hover:underline">{rm.name}</a
              >
            </td>
            <td class="px-6 py-4 text-sm text-gray-600"
              >{rm.serviceName}</td
            >
            <td class="px-6 py-4 text-sm text-gray-600"
              >{formatTimestamp(rm.lastProjectedEventTimestamp)}</td
            >
            <td class="px-6 py-4">
              <StatusBadge status={rm.status} />
            </td>
            <td class="px-6 py-4 text-sm text-gray-600 font-mono"
              >{rm.collections?.join(', ')}</td
            >
            <td class="px-6 py-4 text-right space-x-3">
              <a
                href="/readmodels/{rm.name}/backups?service={rm.serviceName}"
                class="text-sm text-gray-600 hover:text-gray-900"
                >Backups</a
              >
              <a
                href="/readmodels/{rm.name}/replay?service={rm.serviceName}"
                class="text-sm text-blue-600 hover:text-blue-800"
                >Replay</a
              >
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
