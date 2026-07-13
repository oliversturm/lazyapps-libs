<script>
  import { getContext } from 'svelte';
  import StatusBadge from '$lib/components/StatusBadge.svelte';

  const statusStore = getContext('statusStore');

  // A ticking clock so "time ago" / uptime stay live between store updates.
  let now = $state(Date.now());
  $effect(() => {
    const id = setInterval(() => {
      now = Date.now();
    }, 1000);
    return () => clearInterval(id);
  });

  const fmtTimestamp = (ts) => (ts ? new Date(ts).toLocaleString() : '—');

  const fmtDuration = (ms) => {
    const secs = Math.max(0, Math.round(ms / 1000));
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ${secs % 60}s`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ${mins % 60}m`;
    return `${Math.floor(hrs / 24)}d ${hrs % 24}h`;
  };

  const fmtAgo = (ts) => (ts ? `${fmtDuration(now - ts)} ago` : '—');
  const fmtUptime = (startedAt) =>
    startedAt ? fmtDuration(now - startedAt) : '—';
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
          <StatusBadge status={rm.state || 'unknown'} />
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
    {@const cp = $statusStore.commandProcessor}
    <div class="bg-white rounded-lg shadow p-6">
      <div class="flex items-center justify-between mb-3">
        <h2 class="text-lg font-semibold text-gray-900">Command Processor</h2>
        <StatusBadge status={cp.state || 'unknown'} />
      </div>

      {#if cp.activeReplays?.length > 0 || cp.activeCatchUps?.length > 0}
        <div class="flex items-center space-x-3 mb-4">
          {#if cp.activeReplays?.length > 0}
            <span class="text-sm text-gray-600">
              {cp.activeReplays.length} active replay(s)
            </span>
          {/if}
          {#if cp.activeCatchUps?.length > 0}
            <span class="text-sm text-gray-600">
              {cp.activeCatchUps.length} active catch-up(s)
            </span>
          {/if}
        </div>
      {/if}

      <!-- Live detail: proves the CP is healthy without catching the badge
           mid-flash (issue #15). -->
      <dl class="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-3 text-sm">
        <div>
          <dt class="text-xs text-gray-500">Uptime</dt>
          <dd class="text-gray-900">{fmtUptime(cp.startedAt)}</dd>
        </div>
        <div>
          <dt class="text-xs text-gray-500">Commands processed</dt>
          <dd class="text-gray-900">{cp.commandsProcessed ?? '—'}</dd>
        </div>
        <div>
          <dt class="text-xs text-gray-500">Events written</dt>
          <dd class="text-gray-900">{cp.eventsWritten ?? '—'}</dd>
        </div>
        <div>
          <dt class="text-xs text-gray-500">Last command</dt>
          <dd class="text-gray-900">{fmtAgo(cp.lastCommandAt)}</dd>
        </div>
        <div>
          <dt class="text-xs text-gray-500">Last event</dt>
          <dd class="text-gray-900">{fmtTimestamp(cp.lastEventTimestamp)}</dd>
        </div>
      </dl>

      {#if cp.recentReplays?.length > 0}
        <div class="mt-4">
          <h3 class="text-xs font-medium text-gray-500 mb-1">Recent replays</h3>
          <ul class="text-sm text-gray-700 space-y-1">
            {#each cp.recentReplays as r}
              <li class="flex justify-between">
                <span>{r.targetEndpointName}/{r.readModel} — {r.eventsSent} event(s)</span>
                <span class="text-gray-500">{fmtAgo(r.completedAt)}</span>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    </div>
  {/if}
{/if}
