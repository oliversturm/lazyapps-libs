<script>
  import { getContext } from 'svelte';
  import StatusBadge from '$lib/components/StatusBadge.svelte';

  let { data } = $props();

  const api = getContext('api');
  const config = getContext('config');

  let readModel = $state(null);
  let replayStatus = $state(null);
  let loading = $state(true);

  const serviceUrl = $derived(
    data.service
      ? config.readModelServices[data.service]
      : Object.values(config.readModelServices)[0],
  );

  const loadData = () => {
    loading = true;
    Promise.all([
      api
        .getReadModels(serviceUrl)
        .then((models) => models.find((m) => m.name === data.name) || null),
      api.getReplayReadModelStatus('', data.endpointName, data.name)
        .catch(() => null),
    ]).then(([rm, replay]) => {
      readModel = rm;
      replayStatus = replay;
      loading = false;
    });
  };

  $effect(() => {
    if (serviceUrl) loadData();
  });

  const formatTimestamp = (ts) => {
    if (!ts) return 'N/A';
    return new Date(ts).toLocaleString();
  };
</script>

<div class="mb-4">
  <a
    href="/readmodels?service={data.service}"
    class="text-sm text-blue-600 hover:underline">&larr; Back to Read Models</a
  >
</div>

{#if loading}
  <p class="text-gray-500">Loading...</p>
{:else if !readModel}
  <p class="text-red-500">Read model "{data.name}" not found.</p>
{:else}
  <div class="flex items-center justify-between mb-6">
    <div>
      <h1 class="text-2xl font-bold text-gray-900">{data.name}</h1>
      <p class="text-sm text-gray-500">Service: {data.service}</p>
    </div>
    <StatusBadge status={readModel.status} />
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
      </dl>
    </div>

    {#if replayStatus}
      <div class="bg-white rounded-lg shadow p-6">
        <h2 class="text-sm font-medium text-gray-500 mb-2">
          Replay Status
        </h2>
        <div class="flex items-center space-x-2">
          <StatusBadge status={replayStatus.status} />
          {#if replayStatus.lastProjectedEventTimestamp}
            <span class="text-xs text-gray-500">
              Last: {formatTimestamp(
                replayStatus.lastProjectedEventTimestamp,
              )}
            </span>
          {/if}
        </div>
      </div>
    {/if}
  </div>

  <div class="flex space-x-4">
    <a
      href="/readmodels/{data.name}/backups?service={data.service}&endpointName={data.endpointName}"
      class="px-4 py-2 bg-white border border-gray-300 rounded text-sm text-gray-700 hover:bg-gray-50"
    >
      Manage Backups
    </a>
    <a
      href="/readmodels/{data.name}/replay?service={data.service}&endpointName={data.endpointName}"
      class="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700"
    >
      Start Replay
    </a>
  </div>
{/if}
