<script>
  import '../app.css';
  import { setContext } from 'svelte';
  import { createAdminClient } from '$lib/api.js';

  let { data, children } = $props();

  const api = createAdminClient(
    data.commandProcessorUrl,
    data.readModelServices,
  );
  setContext('api', api);
  setContext('config', {
    commandProcessorUrl: data.commandProcessorUrl,
    readModelServices: data.readModelServices,
  });
</script>

<div class="min-h-screen bg-gray-50">
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
            href="/readmodels"
            class="text-sm text-gray-600 hover:text-gray-900"
            >Read Models</a
          >
        </div>
      </div>
    </div>
  </nav>

  <main class="max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
    {@render children()}
  </main>
</div>
