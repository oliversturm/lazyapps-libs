<script>
  import { getContext } from 'svelte';
  import StatusBadge from '$lib/components/StatusBadge.svelte';
  import ProgressBar from '$lib/components/ProgressBar.svelte';
  import TimelineSelector from '$lib/components/TimelineSelector.svelte';

  let { data } = $props();

  const api = getContext('api');
  const config = getContext('config');

  // UI state
  let step = $state('configure'); // configure | preparing | prepared | replaying | done | error
  let error = $state(null);
  let warnings = $state([]);

  // Configuration
  let replayMode = $state('current'); // current | fromScratch | fromBackup
  let selectedBackupId = $state(null);
  let fromTimestamp = $state(0);
  let toTimestamp = $state(null);
  let backups = $state([]);

  // Replay state
  let prepareResult = $state(null);
  let replayProgress = $state(null);
  let pollTimer = $state(null);

  const serviceUrl = $derived(
    data.service
      ? config.readModelServices[data.service]
      : Object.values(config.readModelServices)[0],
  );

  const loadBackups = () => {
    api
      .listBackups(serviceUrl, data.name)
      .then((result) => {
        backups = result;
      })
      .catch(() => {
        backups = [];
      });
  };

  const checkExistingReplay = () => {
    api
      .getReplayReadModelStatus(serviceUrl, data.name)
      .then((status) => {
        if (status && status.status === 'in_progress') {
          step = 'replaying';
          startPolling();
        }
      })
      .catch(() => {});
  };

  $effect(() => {
    if (serviceUrl) {
      loadBackups();
      checkExistingReplay();
    }
  });

  // Cleanup polling on unmount
  $effect(() => () => {
    if (pollTimer) clearInterval(pollTimer);
  });

  const handlePrepare = () => {
    step = 'preparing';
    error = null;
    warnings = [];

    const options = {};
    if (replayMode === 'fromScratch') options.fromScratch = true;
    if (replayMode === 'fromBackup') options.backupId = selectedBackupId;

    api
      .prepareReplay(serviceUrl, data.name, options)
      .then((result) => {
        prepareResult = result;
        fromTimestamp = result.fromTimestamp || 0;
        warnings = result.warnings || [];
        step = 'prepared';
      })
      .catch((err) => {
        error = err.error || String(err);
        step = 'error';
      });
  };

  const handleStartReplay = () => {
    error = null;

    api
      .startReplay(data.name, fromTimestamp, toTimestamp)
      .then(() => {
        step = 'replaying';
        startPolling();
      })
      .catch((err) => {
        error = err.error || String(err);
        step = 'error';
      });
  };

  const handleCancel = () => {
    api
      .cancelReplay(data.name)
      .then(() => {
        stopPolling();
        step = 'configure';
        replayProgress = null;
        prepareResult = null;
      })
      .catch((err) => {
        error = err.error || String(err);
      });
  };

  const startPolling = () => {
    stopPolling();
    pollStatus();
    pollTimer = setInterval(pollStatus, 2000);
  };

  const stopPolling = () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  const pollStatus = () => {
    Promise.all([
      api.getReplayStatus(data.name).catch(() => null),
      api.getReplayReadModelStatus(serviceUrl, data.name).catch(() => null),
    ]).then(([cpStatus, rmStatus]) => {
      replayProgress = {
        eventsPublished: cpStatus?.eventsPublished || 0,
        eventsTotal: cpStatus?.eventsTotal || 0,
        cpStatus: cpStatus?.status || 'unknown',
        rmStatus: rmStatus?.status || 'unknown',
      };

      if (
        cpStatus?.status === 'completed' &&
        rmStatus?.status !== 'in_progress'
      ) {
        stopPolling();
        step = 'done';
      }
    });
  };

  const handleReset = () => {
    step = 'configure';
    error = null;
    warnings = [];
    prepareResult = null;
    replayProgress = null;
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
    href="/readmodels/{data.name}?service={data.service}"
    class="text-sm text-blue-600 hover:underline">&larr; Back to {data.name}</a
  >
</div>

<div class="mb-6">
  <h1 class="text-2xl font-bold text-gray-900">Replay: {data.name}</h1>
  <p class="text-sm text-gray-500">Service: {data.service}</p>
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

{#if warnings.length > 0}
  <div
    class="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded text-sm text-yellow-800"
  >
    <p class="font-medium mb-1">Shared collection warnings:</p>
    <ul class="list-disc list-inside">
      {#each warnings as warning}
        <li>{warning}</li>
      {/each}
    </ul>
    <p class="mt-1 text-xs">
      Consider replaying affected read models sequentially.
    </p>
  </div>
{/if}

{#if step === 'configure'}
  <div class="bg-white rounded-lg shadow p-6 space-y-6">
    <h2 class="text-lg font-semibold text-gray-900">Step 1: Configure Replay</h2>

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
      onclick={handlePrepare}
      disabled={replayMode === 'fromBackup' && !selectedBackupId}
      class="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50"
    >
      Prepare Replay
    </button>
  </div>
{:else if step === 'preparing'}
  <div class="bg-white rounded-lg shadow p-6">
    <p class="text-gray-500">Preparing replay...</p>
  </div>
{:else if step === 'prepared'}
  <div class="bg-white rounded-lg shadow p-6 space-y-4">
    <h2 class="text-lg font-semibold text-gray-900">
      Step 2: Start Replay
    </h2>
    <div class="bg-gray-50 rounded p-4 space-y-2 text-sm">
      <p>
        <span class="text-gray-500">Read Model:</span>
        <span class="font-medium">{prepareResult.readModel}</span>
      </p>
      <p>
        <span class="text-gray-500">Replay from:</span>
        <span class="font-medium"
          >{formatTimestamp(prepareResult.fromTimestamp) || 'Beginning'}</span
        >
      </p>
      {#if toTimestamp}
        <p>
          <span class="text-gray-500">Replay to:</span>
          <span class="font-medium">{formatTimestamp(toTimestamp)}</span>
        </p>
      {/if}
      {#if prepareResult.preReplayBackupId}
        <p>
          <span class="text-gray-500">Safety backup:</span>
          <span class="font-mono text-xs"
            >{prepareResult.preReplayBackupId}</span
          >
        </p>
      {/if}
    </div>

    <div class="flex space-x-3">
      <button
        onclick={handleStartReplay}
        class="px-4 py-2 bg-green-600 text-white rounded text-sm hover:bg-green-700"
      >
        Start Replay
      </button>
      <button
        onclick={handleCancel}
        class="px-4 py-2 bg-gray-200 text-gray-700 rounded text-sm hover:bg-gray-300"
      >
        Cancel
      </button>
    </div>
  </div>
{:else if step === 'replaying'}
  <div class="bg-white rounded-lg shadow p-6 space-y-4">
    <div class="flex items-center justify-between">
      <h2 class="text-lg font-semibold text-gray-900">Replay In Progress</h2>
      <StatusBadge status="replaying" />
    </div>

    {#if replayProgress}
      <ProgressBar
        current={replayProgress.eventsPublished}
        total={replayProgress.eventsTotal}
        label="Events published"
      />
      <div class="grid grid-cols-2 gap-4 text-sm">
        <div>
          <span class="text-gray-500">Command Processor:</span>
          <StatusBadge status={replayProgress.cpStatus} />
        </div>
        <div>
          <span class="text-gray-500">Read Model:</span>
          <StatusBadge status={replayProgress.rmStatus} />
        </div>
      </div>
    {:else}
      <p class="text-gray-500">Waiting for status...</p>
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

    {#if replayProgress}
      <p class="text-sm text-gray-600">
        {replayProgress.eventsPublished} events replayed.
      </p>
    {/if}

    <div class="flex space-x-3">
      <a
        href="/readmodels/{data.name}?service={data.service}"
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
