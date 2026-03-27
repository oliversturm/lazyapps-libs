<script>
  import { getContext } from 'svelte';
  import StatusBadge from '$lib/components/StatusBadge.svelte';

  let { data } = $props();

  const api = getContext('api');
  const statusStore = getContext('statusStore');
  const devMode = getContext('devMode');

  let readModel = $derived(
    $statusStore.readModels.find(
      (rm) =>
        rm.name === data.rm &&
        rm.endpointName === data.ep,
    ) || null,
  );

  let actionPending = $state(false);

  const handleStop = () => {
    actionPending = true;
    api
      .stop(data.ep, data.rm)
      .catch(() => {})
      .then(() => {
        actionPending = false;
      });
  };

  const handleActivate = () => {
    actionPending = true;
    api
      .activate(data.ep, data.rm)
      .catch(() => {})
      .then(() => {
        actionPending = false;
      });
  };

  const handleActivateWithoutCatchup = () => {
    actionPending = true;
    api
      .activateWithoutCatchup(data.ep, data.rm)
      .catch(() => {})
      .then(() => {
        actionPending = false;
      });
  };

  const handleDismissInvalid = () => {
    actionPending = true;
    api
      .dismissInvalid(data.ep, data.rm)
      .catch(() => {})
      .then(() => {
        actionPending = false;
      });
  };

  const formatTimestamp = (ts) => {
    if (!ts) return 'N/A';
    return new Date(ts).toLocaleString();
  };
</script>

<div class="mb-4">
  <a
    href="/readmodel"
    class="text-sm text-blue-600 hover:underline">&larr; Back to Read Models</a
  >
</div>

{#if !readModel}
  <p class="text-gray-500">Read model "{data.rm}" not found. Waiting for data...</p>
{:else}
  <div class="flex items-center justify-between mb-6">
    <div>
      <h1 class="text-2xl font-bold text-gray-900">{readModel.name}</h1>
      <p class="text-sm text-gray-500">Endpoint: {readModel.endpointName}</p>
    </div>
    <StatusBadge status={readModel.state || readModel.status || 'unknown'} />
  </div>

  <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
    <div class="bg-white rounded-lg shadow p-6">
      <h2 class="text-sm font-medium text-gray-500 mb-2">Details</h2>
      <dl class="space-y-2">
        <div>
          <dt class="text-xs text-gray-400">Last Projected Event</dt>
          <dd class="text-sm text-gray-900">
            {formatTimestamp(readModel.lastProjectedEventTimestamp)}
          </dd>
        </div>
        {#if readModel.state}
          <div>
            <dt class="text-xs text-gray-400">Projection Mode</dt>
            <dd class="text-sm text-gray-900">{readModel.state}</dd>
          </div>
        {/if}
      </dl>
    </div>

    {#if readModel.replay}
      <div class="bg-white rounded-lg shadow p-6">
        <h2 class="text-sm font-medium text-gray-500 mb-2">
          Replay Status
        </h2>
        <div class="flex items-center space-x-2">
          <StatusBadge status={readModel.replay.status || 'unknown'} />
          {#if readModel.replay.lastProjectedEventTimestamp}
            <span class="text-xs text-gray-500">
              Last: {formatTimestamp(readModel.replay.lastProjectedEventTimestamp)}
            </span>
          {/if}
        </div>
      </div>
    {/if}
  </div>

  {#if readModel.state === 'invalid'}
    <div class="mb-6 p-4 bg-red-50 border border-red-300 rounded-lg">
      <h3 class="text-sm font-semibold text-red-800 mb-1">Invalid State</h3>
      <p class="text-sm text-red-700">
        This read model is in an invalid state. An interrupted replay or backup
        restore was detected. Manual database intervention is required to
        recover. Contact your administrator.
      </p>
    </div>
    <div class="flex space-x-4">
      <a
        href="/readmodel/{readModel.endpointName}/{readModel.name}/backup"
        class="px-4 py-2 bg-white border border-gray-300 rounded text-sm text-gray-700 hover:bg-gray-50"
      >
        Manage Backups
      </a>
      {#if $devMode}
        <button
          onclick={handleDismissInvalid}
          disabled={actionPending}
          class="px-4 py-2 bg-red-600 text-white rounded text-sm hover:bg-red-700
            disabled:opacity-50 border-2 border-red-800"
        >
          {actionPending ? 'Dismissing...' : 'Dismiss Invalid State'}
        </button>
      {/if}
    </div>
  {:else}
    <div class="flex space-x-4">
      {#if readModel.state === 'live'}
        <button
          onclick={handleStop}
          disabled={actionPending}
          class="px-4 py-2 bg-amber-600 text-white rounded text-sm hover:bg-amber-700 disabled:opacity-50"
        >
          {actionPending ? 'Stopping...' : 'Stop'}
        </button>
      {:else if readModel.state === 'idle' || readModel.state === 'replay-done'}
        <button
          onclick={handleActivate}
          disabled={actionPending}
          class="px-4 py-2 bg-green-600 text-white rounded text-sm hover:bg-green-700 disabled:opacity-50"
        >
          {actionPending ? 'Activating...' : 'Activate'}
        </button>
        {#if $devMode}
          <button
            onclick={handleActivateWithoutCatchup}
            disabled={actionPending}
            class="px-4 py-2 bg-red-600 text-white rounded text-sm hover:bg-red-700
              disabled:opacity-50 border-2 border-red-800"
          >
            {actionPending ? 'Activating...' : 'Activate without Catch-up'}
          </button>
        {/if}
      {/if}
      <a
        href="/readmodel/{readModel.endpointName}/{readModel.name}/backup"
        class="px-4 py-2 bg-white border border-gray-300 rounded text-sm text-gray-700 hover:bg-gray-50"
      >
        Manage Backups
      </a>
      <a
        href="/readmodel/{readModel.endpointName}/{readModel.name}/replay"
        class="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700"
      >
        Start Replay
      </a>
    </div>
  {/if}
{/if}
