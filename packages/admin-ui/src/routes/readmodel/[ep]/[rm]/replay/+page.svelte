<script>
  import { getContext } from 'svelte';
  import StatusBadge from '$lib/components/StatusBadge.svelte';
  import ProgressBar from '$lib/components/ProgressBar.svelte';
  import TimelineSelector from '$lib/components/TimelineSelector.svelte';
  import TimestampEntry from '$lib/components/TimestampEntry.svelte';
  import TzeroDialog from '$lib/components/TzeroDialog.svelte';

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

  let endpointName = $derived(
    readModel?.endpointName || data.ep || '',
  );

  // --- Preflight / T=0 detection ---
  let preflightLoading = $state(true);
  let preflightError = $state(null);
  let preflight = $state(null);
  let isTzero = $derived(preflight?.tzero === true);

  $effect(() => {
    if (endpointName && data.rm) {
      preflightLoading = true;
      preflightError = null;
      api
        .replayPreflight(endpointName, data.rm)
        .then((result) => {
          preflight = result;
          preflightLoading = false;
        })
        .catch((err) => {
          preflightError = err.error || String(err);
          preflightLoading = false;
        });
    }
  });

  // --- T=0 dialog state ---
  let tzeroOption = $state(null);
  let customTimestamp = $state(0);
  let tzeroConfirmed = $state(false);

  const tzeroOptions = {
    replayToCurrent: {
      title: 'Replay to current time',
      detail: 'Replays all events from the beginning up to now. Side effects are suppressed during replay to avoid duplicate actions (emails, webhooks, etc.). After replay, the read model activates normally and processes new events with side effects enabled.',
      confirmWarning: '<p>All historical events will be replayed <strong>without</strong> side effects. After catch-up, new events will trigger side effects normally.</p>',
    },
    catchupOnly: {
      title: 'Skip replay, catch-up only',
      detail: 'Skips the replay phase entirely and goes straight to catch-up mode. All events are processed with side effects enabled. Use this only if you want every side effect to fire for every historical event.',
      confirmWarning: '<p class="text-red-700 font-medium">Every historical event will be processed <strong>with side effects enabled</strong>. This means emails, webhooks, and commands will fire for ALL past events.</p>',
    },
    customTimestamp: {
      title: 'Custom boundary timestamp',
      detail: 'Replay events up to a specific timestamp with side effects suppressed. Events after the boundary are processed during catch-up with side effects enabled. This gives you precise control over where the "no side effects" boundary falls.',
      needsTimestamp: true,
    },
  };

  const resetTzero = () => {
    tzeroOption = null;
    tzeroConfirmed = false;
    customTimestamp = 0;
  };

  // Track whether we initiated a replay in this page session
  let replayInitiated = $state(false);
  let activateAfter = $state(true);

  // Derive replay step from RM state — lifecycle states are unambiguous,
  // so no version tracking or intermediate-state detection is needed.
  let storeStep = $derived.by(() => {
    if (!readModel) return null;
    const mode = readModel.state;
    if (mode === 'replay') return 'replaying';
    if (mode === 'catchup') return 'catchup';
    if (mode === 'live' && replayInitiated) return 'done';
    if (mode === 'replay-done') return 'done-stopped';
    return null;
  });

  // UI state — overridden by store-derived state when in replay/catchup
  let uiStep = $state('configure'); // configure | error | done
  let error = $state(null);

  let step = $derived(storeStep || uiStep);

  // Configuration
  let replayMode = $state('fromScratch'); // fromScratch | fromBackup
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

  // Dev-mode controls (C4 + C5)
  let devEnableSideEffectsDuringReplay = $state(false);
  let devSuppressSideEffectsDuringCatchup = $state(false);
  let devTimestampOverride = $state(0);
  let devUseTimestampOverride = $state(false);

  // Side-effect filter (D5) — dev-mode only, shown when side effects enabled
  let filterString = $state('');
  let filterResult = $state(null);
  let filterValidating = $state(false);
  let filterDebounceTimer = $state(null);

  const validateFilterInput = (value) => {
    if (filterDebounceTimer) clearTimeout(filterDebounceTimer);
    if (!value || !value.trim()) {
      filterResult = null;
      return;
    }
    filterValidating = true;
    filterDebounceTimer = setTimeout(() => {
      api
        .validateFilter(value)
        .then((result) => {
          filterResult = result;
          filterValidating = false;
        })
        .catch(() => {
          filterResult = { filter: null, error: 'Validation request failed' };
          filterValidating = false;
        });
    }, 400);
  };

  $effect(() => {
    validateFilterInput(filterString);
  });

  // Determine if replay button should be disabled
  let replayDisabled = $derived.by(() => {
    if (replayMode === 'fromBackup' && !selectedBackupId) return true;
    if (isTzero && !tzeroConfirmed) return true;
    return false;
  });

  const handleStartReplay = () => {
    error = null;

    const options = {};
    if (replayMode === 'fromScratch') options.fromScratch = true;
    if (replayMode === 'fromBackup') options.backupId = selectedBackupId;
    if (fromTimestamp) options.fromTimestamp = fromTimestamp;
    if (toTimestamp) options.toTimestamp = toTimestamp;
    options.activateAfter = activateAfter;

    // T=0 options
    if (isTzero && tzeroConfirmed) {
      options.t0Option = tzeroOption;
      if (tzeroOption === 'replayToCurrent') {
        options.toTimestamp = Date.now();
        options.suppressSideEffects = true;
      } else if (tzeroOption === 'catchupOnly') {
        options.t0Option = 'skipReplayCatchUpOnly';
      } else if (tzeroOption === 'customTimestamp') {
        options.t0Option = 'customBoundary';
        options.customTimestamp = customTimestamp;
        options.suppressSideEffects = true;
      }
    }

    // Dev-mode overrides
    if ($devMode) {
      if (devEnableSideEffectsDuringReplay) {
        options.enableSideEffectsDuringReplay = true;
      }
      if (devSuppressSideEffectsDuringCatchup) {
        options.suppressSideEffectsDuringCatchup = true;
      }
      if (devUseTimestampOverride && devTimestampOverride > 0) {
        options.timestampOverride = devTimestampOverride;
      }
      if (
        devEnableSideEffectsDuringReplay &&
        filterString.trim() &&
        filterResult?.filter
      ) {
        options.sideEffectFilter = filterResult.filter;
      }
    }

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

  const handleActivate = () => {
    api.activate(data.ep, data.rm).catch((err) => {
      error = err.error || String(err);
    });
  };

  const handleReset = () => {
    uiStep = 'configure';
    error = null;
    selectedBackupId = null;
    replayMode = 'fromScratch';
    fromTimestamp = 0;
    toTimestamp = null;
    resetTzero();
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

{#if preflightLoading}
  <div class="bg-white rounded-lg shadow p-6">
    <p class="text-sm text-gray-500">Checking read model status...</p>
  </div>
{:else if preflightError}
  <div class="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded text-sm text-yellow-700">
    Could not check preflight status: {preflightError}. Proceeding with normal replay UI.
  </div>
{/if}

{#if readModel?.state === 'invalid'}
  <div class="bg-red-50 border border-red-300 rounded-lg p-6">
    <h2 class="text-lg font-semibold text-red-800 mb-2">Invalid State</h2>
    <p class="text-sm text-red-700">
      This read model is in an invalid state. An interrupted replay or backup
      restore was detected. Replay controls are disabled. Manual database
      intervention is required to recover. Contact your administrator.
    </p>
  </div>
{:else if step === 'configure'}
  <!-- T=0 Warning and Options Dialog -->
  {#if isTzero}
    <TzeroDialog
      options={tzeroOptions}
      lastEventStoreTimestamp={preflight?.lastEventStoreTimestamp}
      bind:confirmed={tzeroConfirmed}
      bind:selectedOption={tzeroOption}
      bind:customTimestamp
    />
  {/if}

  <!-- Normal replay configuration (gated by T=0 if applicable) -->
  <div class="bg-white rounded-lg shadow p-6 space-y-6
    {isTzero && !tzeroConfirmed ? 'opacity-40 pointer-events-none' : ''}">
    <h2 class="text-lg font-semibold text-gray-900">Configure Replay</h2>

    {#if tzeroOption !== 'catchupOnly'}
      <div>
        <p class="text-sm font-medium text-gray-700 mb-3">Starting point</p>
        <div class="space-y-2">
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
    {:else}
      <p class="text-sm text-gray-600">
        Catch-up only mode selected. The read model will skip replay and go
        directly to catch-up, processing all events with side effects enabled.
      </p>
    {/if}

    <div>
      <label class="flex items-center space-x-2">
        <input type="checkbox" bind:checked={activateAfter} class="text-blue-600" />
        <span class="text-sm text-gray-700">Activate after replay (go live)</span>
      </label>
      <p class="text-xs text-gray-400 ml-6">When unchecked, the read model stays stopped after replay for inspection.</p>
    </div>

    <!-- Dev-mode controls -->
    {#if $devMode}
      <div class="border-2 border-red-300 rounded-lg p-4 bg-red-50 space-y-3">
        <p class="text-xs font-bold text-red-800 uppercase tracking-wide">Dev-mode overrides</p>

        <label class="flex items-center space-x-2">
          <input
            type="checkbox"
            bind:checked={devEnableSideEffectsDuringReplay}
            class="text-red-600"
          />
          <span class="text-sm text-red-800">Enable side effects during replay</span>
        </label>

        {#if devEnableSideEffectsDuringReplay}
          <div class="ml-6 space-y-2">
            <label class="block text-sm text-red-800 font-medium">
              Side-effect filter (optional)
            </label>
            <textarea
              bind:value={filterString}
              placeholder="e.g. IncludeByName('sendEmail', 'sendWebhook')"
              rows="3"
              class="block w-full rounded border-red-300 bg-white text-sm px-3 py-2 border
                font-mono focus:border-red-500 focus:ring-red-500"
            ></textarea>

            {#if filterValidating}
              <p class="text-xs text-gray-500">Validating...</p>
            {:else if filterResult?.error}
              <p class="text-xs text-red-700">{filterResult.error}</p>
            {:else if filterResult?.filter}
              <p class="text-xs text-green-700">Valid filter</p>
            {/if}

            <details class="text-xs text-red-700">
              <summary class="cursor-pointer hover:underline">Syntax help</summary>
              <div class="mt-1 space-y-1 text-red-600">
                <p><code>IncludeByName('name1', 'name2')</code> — only run these side effects</p>
                <p><code>ExcludeByName('name1', 'name2')</code> — run all except these</p>
                <p><code>IncludeCommand('cmd1', 'cmd2')</code> — only run side effects that send these commands</p>
                <p><code>ExcludeCommand('cmd1', 'cmd2')</code> — skip side effects that send these commands</p>
                <p>Combine one ByName + one Command filter with <code>&&</code> or a newline.</p>
              </div>
            </details>
          </div>
        {/if}

        <label class="flex items-center space-x-2">
          <input
            type="checkbox"
            bind:checked={devSuppressSideEffectsDuringCatchup}
            class="text-red-600"
          />
          <span class="text-sm text-red-800">Suppress side effects during catch-up</span>
        </label>

        <div>
          <label class="flex items-center space-x-2">
            <input
              type="checkbox"
              bind:checked={devUseTimestampOverride}
              class="text-red-600"
            />
            <span class="text-sm text-red-800">Timestamp override</span>
          </label>
          {#if devUseTimestampOverride}
            <div class="mt-2 ml-6">
              <TimestampEntry
                bind:value={devTimestampOverride}
                label="Override timestamp"
              />
            </div>
          {/if}
        </div>
      </div>
    {/if}

    <button
      onclick={handleStartReplay}
      disabled={replayDisabled}
      class="px-4 py-2 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {tzeroOption === 'catchupOnly' ? 'Start Catch-up' : 'Start Replay'}
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
{:else if step === 'done-stopped'}
  <div class="bg-white rounded-lg shadow p-6 space-y-4">
    <div class="flex items-center space-x-2">
      <h2 class="text-lg font-semibold text-amber-700">Replay Complete — Stopped</h2>
      <StatusBadge status="replay-done" />
    </div>
    <p class="text-sm text-gray-600">
      The read model has been replayed and is currently stopped. You can inspect the data before activating.
    </p>
    <div class="flex space-x-3">
      <button onclick={handleActivate} class="px-4 py-2 bg-green-600 text-white rounded text-sm hover:bg-green-700">
        Activate (Go Live)
      </button>
      <a href="/readmodel/{data.ep}/{data.rm}" class="px-4 py-2 bg-gray-200 text-gray-700 rounded text-sm hover:bg-gray-300">
        View Read Model
      </a>
      <button onclick={handleReset} class="px-4 py-2 bg-gray-200 text-gray-700 rounded text-sm hover:bg-gray-300">
        Start New Replay
      </button>
    </div>
  </div>
{/if}
