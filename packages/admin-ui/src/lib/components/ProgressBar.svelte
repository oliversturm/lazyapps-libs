<script>
  let { current = 0, total = 0, label = '' } = $props();

  let percentage = $derived(total > 0 ? Math.round((current / total) * 100) : 0);
</script>

<div>
  {#if label}
    <div class="flex justify-between text-sm text-gray-600 mb-1">
      <span>{label}</span>
      <span>{current} / {total} ({percentage}%)</span>
    </div>
  {/if}
  <div class="w-full bg-gray-200 rounded-full h-2.5">
    <div
      class="bg-blue-600 h-2.5 rounded-full transition-all duration-300"
      style="width: {percentage}%"
    ></div>
  </div>
</div>
