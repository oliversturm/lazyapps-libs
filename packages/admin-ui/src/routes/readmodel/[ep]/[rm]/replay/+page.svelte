<script>
  import { getContext } from 'svelte';
  import StatusBadge from '$lib/components/StatusBadge.svelte';
  import ProgressBar from '$lib/components/ProgressBar.svelte';
  import TimelineSelector from '$lib/components/TimelineSelector.svelte';

  let { data } = $props();

  const api = getContext('api');
  const statusStore = getContext('statusStore');

  let readModel = $derived(
    $statusStore.readModels.find(
      (rm) =>
        rm.name === data.rm &&
        rm.endpointName === data.ep,
    ) || null,
  );

  let endpointName = $derived(
    readModel?.endpointName || data.ep || '',
  );

  // Track whether we initiated a replay in this page session
  let replayInitiated = $state(false);

  // Derive replay step from store state
  let storeStep = $derived.by(() => {
    if (!readModel) return null;
    const mode = readModel.state;
    if (mode === 'replay') return 'replaying';
    if (mode === 'catchup') return 'catchup';
    // If we initiated a replay and RM is now live, replay is complete
    if (replayInitiated && mode === 'live') return 'done';
    return null;
  });

  // UI state — overridden by store-derived state when in replay/catchup
  let uiStep = $state('configure'); // configure | error | done
  let error = $state(null);

  let step = $derived(storeStep || uiStep);

  // Configuration
  let replayMode = $state('current'); // current | fromScratch | fromBackup
  let selectedBackupId = $state(null);
  let fromTimestamp = $state(0);
  let toTimestamp = $state(null);
  let backups = $state([]);

  const loadBackups = () => {
    api
      .listBackups(endpointName, data.rm)
      .then((result) => {
        backups = result;
      })
      .catch(() => {
        backups = [];
      });
  };

  $effect(() => {
    if (endpointName) loadBackups();
  });

  const handleStartReplay = () => {
    error = null;

    const options = {};
    if (replayMode === 'fromScratch') options.fromScratch = true;
    if (replayMode === 'fromBackup') options.backupId = selectedBackupId;
    if (fromTimestamp) options.fromTimestamp = fromTimestamp;
    if (toTimestamp) options.toTimestamp = toTimestamp;

    replayInitiated = true;
    api
      .startReplay(endpointName, data.rm, options)
      .then(() => {
        // Status updates arrive via layout SSE — no polling needed
      })
      .catch((err) => {
        error = err.error || String(err);
        uiStep = 'error';
      });
  };

  const handleCancel = () => {
    api
      .cancelReplay(endpointName, data.rm, {})
      .then(() => {
        uiStep = 'configure';
      })
      .catch((err) => {
        error = err.error || String(err);
      });
  };

  const handleReset = () => {
    uiStep = 'configure';
    error = null;
    selectedBackupId = null;
    replayMode = 'current';
    fromTimestamp = 0;
    toTimestamp = null;
  };

  const formatTimestamp = (ts) => {
    if (!ts) return 'N/A';
    return new Date(ts).toLocaleString();
  };
</script>

<div class="mb-4">
  <a
    href="/readmodel/{data.ep}/{data.rm}"
    class="text-sm text-blue-600 hover:underline">&larr; Back to {data.rm}</a
  >
</div>

<div class="mb-6">
  <h1 class="text-2xl font-bold text-gray-900">Replay: {data.rm}</h1>
  {#if endpointName}
    <p class="text-sm text-gray-500">Endpoint: {endpointName}</p>
  {/if}
</div>

{#if error}
  <div
    class="mb-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700"
  >
    {error}
    {#if step === 'error'}
      <button
        onclick={handleReset}
        class="ml-2 text-red-800 underline hover:no-underline">Reset</button
      >
    {/if}
  </div>
{/if}

{#if step === 'configure'}
  <div class="bg-white rounded-lg shadow p-6 space-y-6">
    <h2 class="text-lg font-semibold text-gray-900">Configure Replay</h2>

    <div>
      <p class="text-sm font-medium text-gray-700 mb-3">Starting point</p>
      <div class="space-y-2">
        <label class="flex items-center space-x-2">
          <input
            type="radio"
            bind:group={replayMode}
            value="current"
            class="text-blue-600"
          />
          <span class="text-sm text-gray-700"
            >From current state (replay missed events only)</span
          >
        </label>
        <label class="flex items-center space-x-2">
          <input
            type="radio"
            bind:group={replayMode}
            value="fromScratch"
            class="text-blue-600"
          />
          <span class="text-sm text-gray-700"
            >From scratch (clear data, replay all events)</span
          >
        </label>
        <label class="flex items-center space-x-2">
          <input
            type="radio"
            bind:group={replayMode}
            value="fromBackup"
            class="text-blue-600"
          />
          <span class="text-sm text-gray-700"
            >From backup (restore backup, replay from that point)</span
          >
        </label>
      </div>
    </div>

    {#if replayMode === 'fromBackup'}
      <div>
        <p class="text-sm font-medium text-gray-700 mb-2">Select backup</p>
        {#if backups.length === 0}
          <p class="text-sm text-gray-500">No backups available.</p>
        {:else}
          <select
            bind:value={selectedBackupId}
            class="block w-full rounded border-gray-300 shadow-sm text-sm px-3 py-2 border"
          >
            <option value={null}>-- Select a backup --</option>
            {#each backups as backup}
              <option value={backup.backupId}>
                {backup.backupId} ({formatTimestamp(backup.timestamp)})
              </option>
            {/each}
          </select>
        {/if}
      </div>
    {/if}

    <div>
      <p class="text-sm font-medium text-gray-700 mb-2">
        Event time range (optional override)
      </p>
      <TimelineSelector bind:fromTimestamp bind:toTimestamp />
    </div>

    <button
      onclick={handleStartReplay}
      disabled={replayMode === 'fromBackup' && !selectedBackupId}
      class="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
    >
      Start Replay
    </button>
  </div>
{:else if step === 'replaying' || step === 'catchup'}
  <div class="bg-white rounded-lg shadow p-6 space-y-4">
    <div class="flex items-center justify-between">
      <h2 class="text-lg font-semibold text-gray-900">
        {step === 'replaying' ? 'Replay In Progress' : 'Catch-up In Progress'}
      </h2>
      <StatusBadge status={step === 'replaying' ? 'replaying' : 'catchup'} />
    </div>

    {#if readModel}
      <div class="grid grid-cols-2 gap-4 text-sm">
        <div>
          <span class="text-gray-500">Projection Mode:</span>
          <StatusBadge status={readModel.state || 'unknown'} />
        </div>
        {#if readModel.lastProjectedEventTimestamp}
          <div>
            <span class="text-gray-500">Last Projected:</span>
            <span class="text-gray-900">{formatTimestamp(readModel.lastProjectedEventTimestamp)}</span>
          </div>
        {/if}
      </div>

      {#if readModel.replay?.eventsPublished != null && readModel.replay?.eventsTotal != null}
        <ProgressBar
          current={readModel.replay.eventsPublished}
          total={readModel.replay.eventsTotal}
          label="Events published"
        />
      {/if}
    {/if}

    <button
      onclick={handleCancel}
      class="px-4 py-2 bg-red-600 text-white rounded text-sm hover:bg-red-700"
    >
      Cancel Replay
    </button>
  </div>
{:else if step === 'done'}
  <div class="bg-white rounded-lg shadow p-6 space-y-4">
    <div class="flex items-center space-x-2">
      <h2 class="text-lg font-semibold text-green-700">Replay Complete</h2>
      <StatusBadge status="completed" />
    </div>

    <div class="flex space-x-3">
      <a
        href="/readmodel/{data.ep}/{data.rm}"
        class="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700"
      >
        View Read Model
      </a>
      <button
        onclick={handleReset}
        class="px-4 py-2 bg-gray-200 text-gray-700 rounded text-sm hover:bg-gray-300"
      >
        Start New Replay
      </button>
    </div>
  </div>
{/if}
