<script>
  let { status } = $props();

  const colors = {
    active: 'bg-green-100 text-green-800',
    live: 'bg-green-100 text-green-800',
    idle: 'bg-gray-100 text-gray-800',
    stopped: 'bg-gray-100 text-gray-800',
    replay: 'bg-yellow-100 text-yellow-800',
    replaying: 'bg-yellow-100 text-yellow-800',
    'replay-done': 'bg-blue-100 text-blue-800',
    catchup: 'bg-yellow-100 text-yellow-800',
    in_progress: 'bg-yellow-100 text-yellow-800',
    prepared: 'bg-blue-100 text-blue-800',
    completed: 'bg-green-100 text-green-800',
    cancelled: 'bg-gray-100 text-gray-600',
    error: 'bg-red-100 text-red-800',
    started: 'bg-blue-100 text-blue-800',
    cancelling: 'bg-orange-100 text-orange-800',
    invalid: 'bg-red-100 text-red-800',
  };

  let colorClass = $derived(colors[status] || 'bg-gray-100 text-gray-800');
</script>

<span
  class="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium {colorClass}"
>
  {status}
</span>
