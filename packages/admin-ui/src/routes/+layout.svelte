<script>
  import '../app.css';
  import { onDestroy, setContext } from 'svelte';
  import { writable } from 'svelte/store';
  import { createAdminClient } from '$lib/api.js';
  import { createSseConnection } from '$lib/sse.js';
  import { createStatusStore } from '$lib/statusStore.js';

  let { children } = $props();

  const api = createAdminClient();
  const statusStore = createStatusStore();
  const devMode = writable(false);

  setContext('api', api);
  setContext('statusStore', statusStore);
  setContext('devMode', devMode);

  // Fetch dev-mode config on startup
  api.getConfig()
    .then((config) => {
      devMode.set(!!config.developmentMode);
    })
    .catch(() => {
      devMode.set(false);
    });

  let refreshing = $state(false);

  const handleRefresh = () => {
    refreshing = true;
    Promise.all([
      api.refreshStatus().catch(() => null),
      api.getCommandProcessorStatus().catch(() => null),
    ]).then(([rmStatus, cpStatus]) => {
      if (rmStatus) statusStore.replaceAllReadModels(rmStatus);
      if (cpStatus) statusStore.updateCommandProcessorStatus(cpStatus);
      refreshing = false;
    });
  };

  const sse = createSseConnection('/admin/events');

  sse
    .on('connected', () => {
      statusStore.setConnected(true);
    })
    .on('disconnected', () => {
      statusStore.setConnected(false);
    })
    .on('readmodel-status', (data) => {
      statusStore.updateReadModelStatus(data);
    })
    .on('commandprocessor-status', (data) => {
      statusStore.updateCommandProcessorStatus(data);
    });

  onDestroy(() => {
    sse.close();
  });
</script>

<div class="min-h-screen bg-gray-50">
  {#if $devMode}
    <div class="bg-red-600 text-white text-center py-1.5 px-4 text-xs font-bold tracking-wide">
      DEVELOPMENT MODE — Dev-only controls are active. Do not use in production.
    </div>
  {/if}

  <nav class="bg-white border-b border-gray-200">
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
      <div class="flex h-14 items-center justify-between">
        <div class="flex items-center space-x-8">
          <a href="/" class="text-lg font-bold text-gray-900"
            >LazyApps Admin</a
          >
          <a
            href="/"
            class="text-sm text-gray-600 hover:text-gray-900"
            >Dashboard</a
          >
          <a
            href="/readmodel"
            class="text-sm text-gray-600 hover:text-gray-900"
            >Read Models</a
          >
        </div>
        <div class="flex items-center space-x-3">
          {#if $devMode}
            <span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-red-100 text-red-800">DEV</span>
          {/if}
          {#if $statusStore.connected}
            <span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-green-100 text-green-800">Connected</span>
          {:else}
            <span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-red-100 text-red-800">Disconnected</span>
          {/if}
          <button
            onclick={handleRefresh}
            disabled={refreshing}
            class="px-3 py-1.5 bg-gray-100 text-gray-700 text-sm rounded hover:bg-gray-200 disabled:opacity-50"
          >
            {refreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>
    </div>
  </nav>

  <main class="max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
    {@render children()}
  </main>
</div>
