<script>
  import { getContext } from 'svelte';
  import StatusBadge from '$lib/components/StatusBadge.svelte';

  const api = getContext('api');
  const config = getContext('config');

  let services = $state({});
  let loading = $state(true);
  let error = $state(null);

  const loadServices = () => {
    loading = true;
    error = null;

    Promise.all(
      Object.entries(config.readModelServices).map(([name, url]) =>
        api
          .getStatus(url)
          .then((status) => ({ name, url, ...status, error: null }))
          .catch((err) => ({
            name,
            url,
            error: String(err),
            readModels: [],
          })),
      ),
    ).then((results) => {
      const svc = {};
      results.forEach((r) => {
        svc[r.name] = r;
      });
      services = svc;
      loading = false;
    });
  };

  $effect(() => {
    loadServices();
  });
</script>

<div class="flex items-center justify-between mb-6">
  <h1 class="text-2xl font-bold text-gray-900">Dashboard</h1>
  <button
    onclick={loadServices}
    class="px-3 py-1.5 bg-gray-100 text-gray-700 text-sm rounded hover:bg-gray-200"
  >
    Refresh
  </button>
</div>

{#if loading}
  <p class="text-gray-500">Loading services...</p>
{:else}
  <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
    {#each Object.entries(services) as [name, service]}
      <div class="bg-white rounded-lg shadow p-6">
        <div class="flex items-center justify-between mb-3">
          <h2 class="text-lg font-semibold text-gray-900">{name}</h2>
          {#if service.error}
            <StatusBadge status="error" />
          {:else}
            <StatusBadge status="active" />
          {/if}
        </div>

        {#if service.error}
          <p class="text-sm text-red-500">{service.error}</p>
        {:else}
          <p class="text-xs text-gray-500 mb-3">
            {service.service} &middot; Uptime: {Math.round(
              service.uptime / 1000,
            )}s
          </p>
          <div class="space-y-2">
            {#each service.readModels || [] as rm}
              <div class="flex items-center justify-between">
                <a
                  href="/readmodels/{rm.name}?service={name}"
                  class="text-sm text-blue-600 hover:underline"
                >
                  {rm.name}
                </a>
                <StatusBadge
                  status={rm.replaying ? 'replaying' : 'active'}
                />
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/each}
  </div>
{/if}
