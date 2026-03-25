<script>
  import TimestampEntry from './TimestampEntry.svelte';

  let {
    options,
    lastEventStoreTimestamp = null,
    confirmed = $bindable(false),
    selectedOption = $bindable(null),
    customTimestamp = $bindable(0),
  } = $props();

  let showConfirmModal = $state(false);

  let optionValid = $derived.by(() => {
    if (!selectedOption) return false;
    const opt = options[selectedOption];
    if (!opt) return false;
    if (opt.needsTimestamp) {
      return customTimestamp > 0 &&
        (lastEventStoreTimestamp === null ||
         customTimestamp <= lastEventStoreTimestamp);
    }
    return true;
  });

  const handleConfirm = () => {
    showConfirmModal = true;
  };

  const confirmSelection = () => {
    confirmed = true;
    showConfirmModal = false;
  };

  const cancelConfirm = () => {
    showConfirmModal = false;
  };

  const reset = () => {
    selectedOption = null;
    confirmed = false;
    showConfirmModal = false;
    customTimestamp = 0;
  };

  const selectedDesc = $derived(
    selectedOption ? options[selectedOption] : null,
  );
</script>

{#if !confirmed}
  <div class="bg-amber-50 border-2 border-amber-400 rounded-lg p-6 mb-6">
    <div class="flex items-start gap-3 mb-4">
      <div class="shrink-0 w-8 h-8 bg-amber-400 text-white rounded-full flex items-center justify-center font-bold text-sm">!</div>
      <div>
        <h2 class="text-lg font-bold text-amber-900">Fresh Read Model Detected</h2>
        <p class="text-sm text-amber-800 mt-1">
          This read model has never processed any events (timestamp = 0). This operation
          requires a decision about <strong>side effects</strong> &mdash; actions like sending emails,
          webhooks, or commands that occur during event projection.
        </p>
        <p class="text-sm text-amber-800 mt-2 font-medium">
          Choose carefully. Processing events with side effects enabled will fire every side effect for every
          historical event. This is usually not what you want.
        </p>
      </div>
    </div>

    <div class="space-y-3 mt-5">
      {#each Object.entries(options) as [key, desc], i}
        <label
          class="flex items-start gap-3 p-4 rounded-lg border-2 cursor-pointer transition-colors
            {selectedOption === key
              ? 'border-blue-500 bg-blue-50'
              : 'border-gray-200 bg-white hover:border-gray-300'}"
        >
          <input
            type="radio"
            bind:group={selectedOption}
            value={key}
            class="mt-1 text-blue-600"
          />
          <div class="flex-1">
            <div class="flex items-center gap-2">
              <span class="inline-flex items-center justify-center w-5 h-5 bg-gray-200 text-gray-600 rounded-full text-xs font-bold">{i + 1}</span>
              <span class="text-sm font-semibold text-gray-900">{desc.title}</span>
            </div>
            <p class="text-xs text-gray-600 mt-1 leading-relaxed">{desc.detail}</p>
          </div>
        </label>
      {/each}
    </div>

    {#if selectedDesc?.needsTimestamp}
      <div class="mt-4 ml-8 p-4 bg-white rounded-lg border border-gray-200">
        <TimestampEntry
          bind:value={customTimestamp}
          max={lastEventStoreTimestamp}
          label="Side-effect suppression boundary"
        />
        {#if lastEventStoreTimestamp}
          <p class="text-xs text-gray-400 mt-2">
            Last event in store: {lastEventStoreTimestamp}
            ({new Date(lastEventStoreTimestamp).toISOString()})
          </p>
        {/if}
      </div>
    {/if}

    <div class="mt-5 flex items-center gap-3">
      <button
        type="button"
        onclick={handleConfirm}
        disabled={!optionValid}
        class="px-4 py-2 bg-amber-600 text-white rounded text-sm font-medium
          hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        Confirm Selection
      </button>
      {#if selectedDesc}
        <span class="text-xs text-gray-500">
          Selected: {selectedDesc.title}
        </span>
      {/if}
    </div>
  </div>
{:else}
  <!-- Confirmed summary -->
  <div class="bg-green-50 border border-green-300 rounded-lg p-4 mb-6">
    <div class="flex items-center justify-between">
      <div>
        <p class="text-sm font-medium text-green-800">
          T=0 option confirmed: {selectedDesc?.title}
        </p>
        {#if selectedDesc?.needsTimestamp}
          <p class="text-xs text-green-700 mt-1">
            Boundary: {customTimestamp} ({new Date(customTimestamp).toISOString()})
          </p>
        {/if}
      </div>
      <button
        type="button"
        onclick={reset}
        class="text-xs text-green-700 underline hover:no-underline"
      >
        Change
      </button>
    </div>
  </div>
{/if}

<!-- Confirmation Modal -->
{#if showConfirmModal}
  <div class="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
    <div class="bg-white rounded-lg shadow-xl p-6 max-w-md mx-4">
      <h3 class="text-lg font-bold text-gray-900 mb-3">Are you sure?</h3>
      <div class="text-sm text-gray-700 space-y-2 mb-5">
        <p>You selected: <strong>{selectedDesc?.title}</strong></p>
        {#if selectedDesc?.confirmWarning}
          {@html selectedDesc.confirmWarning}
        {:else}
          <p>{selectedDesc?.detail}</p>
        {/if}
        <p class="font-medium">This action cannot be undone once started.</p>
      </div>
      <div class="flex gap-3 justify-end">
        <button
          type="button"
          onclick={cancelConfirm}
          class="px-4 py-2 bg-gray-200 text-gray-700 rounded text-sm hover:bg-gray-300"
        >
          Go Back
        </button>
        <button
          type="button"
          onclick={confirmSelection}
          class="px-4 py-2 bg-amber-600 text-white rounded text-sm font-medium hover:bg-amber-700"
        >
          Yes, I'm sure
        </button>
      </div>
    </div>
  </div>
{/if}
