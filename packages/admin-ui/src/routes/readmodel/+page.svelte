<script>
  import { getContext } from 'svelte';
  import StatusBadge from '$lib/components/StatusBadge.svelte';

  const statusStore = getContext('statusStore');

  const formatTimestamp = (ts) => {
    if (!ts) return 'N/A';
    return new Date(ts).toLocaleString();
  };
</script>

<div class="mb-6">
  <h1 class="text-2xl font-bold text-gray-900">Read Models</h1>
</div>

{#if $statusStore.readModels.length === 0}
  <p class="text-gray-500">No read models found. Waiting for data...</p>
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
            >Endpoint</th
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
            class="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase"
            >Actions</th
          >
        </tr>
      </thead>
      <tbody class="bg-white divide-y divide-gray-200">
        {#each $statusStore.readModels as rm}
          <tr>
            <td class="px-6 py-4 text-sm font-medium text-gray-900">
              <a
                href="/readmodel/{rm.endpointName}/{rm.name}"
                class="text-blue-600 hover:underline">{rm.name}</a
              >
            </td>
            <td class="px-6 py-4 text-sm text-gray-600"
              >{rm.endpointName}</td
            >
            <td class="px-6 py-4 text-sm text-gray-600"
              >{formatTimestamp(rm.lastProjectedEventTimestamp)}</td
            >
            <td class="px-6 py-4">
              <StatusBadge status={rm.state || 'unknown'} />
            </td>
            <td class="px-6 py-4 text-right space-x-3">
              <a
                href="/readmodel/{rm.endpointName}/{rm.name}/backup"
                class="text-sm text-gray-600 hover:text-gray-900"
                >Backups</a
              >
              <a
                href="/readmodel/{rm.endpointName}/{rm.name}/replay"
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
