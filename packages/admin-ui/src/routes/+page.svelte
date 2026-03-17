<script>
  import { getContext } from 'svelte';
  import StatusBadge from '$lib/components/StatusBadge.svelte';

  const statusStore = getContext('statusStore');
</script>

<div class="mb-6">
  <h1 class="text-2xl font-bold text-gray-900">Dashboard</h1>
</div>

{#if $statusStore.readModels.length === 0}
  <p class="text-gray-500">No read model status available. Waiting for data...</p>
{:else}
  <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 mb-8">
    {#each $statusStore.readModels as rm}
      <div class="bg-white rounded-lg shadow p-6">
        <div class="flex items-center justify-between mb-3">
          <a
            href="/readmodel/{rm.endpointName}/{rm.name}"
            class="text-lg font-semibold text-blue-600 hover:underline"
          >
            {rm.name}
          </a>
          <StatusBadge status={rm.projectionMode || rm.status || 'unknown'} />
        </div>
        <p class="text-xs text-gray-500 mb-1">
          Endpoint: {rm.endpointName}
        </p>
        {#if rm.lastProjectedEventTimestamp}
          <p class="text-xs text-gray-500">
            Last projected: {new Date(rm.lastProjectedEventTimestamp).toLocaleString()}
          </p>
        {/if}
      </div>
    {/each}
  </div>

  {#if $statusStore.commandProcessor}
    <div class="bg-white rounded-lg shadow p-6">
      <h2 class="text-lg font-semibold text-gray-900 mb-3">Command Processor</h2>
      <div class="flex items-center space-x-3">
        <StatusBadge status={$statusStore.commandProcessor.state || 'idle'} />
        {#if $statusStore.commandProcessor.activeReplays?.length > 0}
          <span class="text-sm text-gray-600">
            {$statusStore.commandProcessor.activeReplays.length} active replay(s)
          </span>
        {/if}
        {#if $statusStore.commandProcessor.activeCatchUps?.length > 0}
          <span class="text-sm text-gray-600">
            {$statusStore.commandProcessor.activeCatchUps.length} active catch-up(s)
          </span>
        {/if}
      </div>
    </div>
  {/if}
{/if}
