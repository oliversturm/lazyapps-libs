<script>
  let { fromTimestamp = $bindable(0), toTimestamp = $bindable(null) } = $props();

  let useToTimestamp = $state(false);

  const tsToDatetime = (ts) => {
    if (!ts) return '';
    return new Date(ts).toISOString().slice(0, 16);
  };

  const datetimeToTs = (dt) => {
    if (!dt) return null;
    return new Date(dt).getTime();
  };

  let fromDatetime = $state(tsToDatetime(fromTimestamp));
  let toDatetime = $state(tsToDatetime(toTimestamp));

  $effect(() => {
    fromTimestamp = datetimeToTs(fromDatetime) || 0;
  });

  $effect(() => {
    toTimestamp = useToTimestamp ? datetimeToTs(toDatetime) : null;
  });
</script>

<div class="space-y-3">
  <div>
    <label for="from-ts" class="block text-sm font-medium text-gray-700"
      >From</label
    >
    <input
      id="from-ts"
      type="datetime-local"
      bind:value={fromDatetime}
      class="mt-1 block w-full rounded border-gray-300 shadow-sm text-sm px-3 py-2 border"
    />
  </div>

  <div>
    <label class="flex items-center space-x-2">
      <input type="checkbox" bind:checked={useToTimestamp} class="rounded" />
      <span class="text-sm text-gray-700">Set end timestamp</span>
    </label>
    {#if useToTimestamp}
      <input
        type="datetime-local"
        bind:value={toDatetime}
        class="mt-1 block w-full rounded border-gray-300 shadow-sm text-sm px-3 py-2 border"
      />
    {/if}
  </div>
</div>
