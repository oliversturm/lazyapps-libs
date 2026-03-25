<script>
  let {
    value = $bindable(0),
    max = null,
    label = 'Timestamp',
    disabled = false,
  } = $props();

  // Format a Unix ms timestamp to an ISO datetime-local string with ms
  const tsToDatetimeParts = (ts) => {
    if (!ts || ts <= 0) return { datetime: '', ms: '000' };
    const d = new Date(ts);
    // datetime-local only supports seconds precision
    const datetime = d.toISOString().slice(0, 19);
    const ms = String(d.getUTCMilliseconds()).padStart(3, '0');
    return { datetime, ms };
  };

  // Parse datetime string + ms to Unix ms timestamp
  const partsToTs = (datetime, ms) => {
    if (!datetime) return 0;
    const msNum = Math.min(999, Math.max(0, parseInt(ms, 10) || 0));
    const base = new Date(datetime + 'Z').getTime();
    if (isNaN(base)) return 0;
    return base + msNum;
  };

  // Internal state for the two input representations
  let parts = $state(tsToDatetimeParts(value));
  let numericInput = $state(String(value || ''));
  let lastSyncSource = $state(null);

  // Validation
  let validationError = $derived.by(() => {
    if (!value && value !== 0) return null;
    if (value < 0) return 'Timestamp must be positive';
    if (value === 0) return 'Please enter a timestamp';
    if (max !== null && value > max)
      return `Timestamp exceeds maximum (${max})`;
    return null;
  });

  let isValid = $derived(!validationError && value > 0);

  // Sync: numeric input -> value -> datetime parts
  const handleNumericInput = (e) => {
    const raw = e.target.value.replace(/[^0-9]/g, '');
    numericInput = raw;
    const parsed = parseInt(raw, 10);
    if (!isNaN(parsed) && parsed >= 0) {
      value = parsed;
      parts = tsToDatetimeParts(parsed);
      lastSyncSource = 'numeric';
    } else if (raw === '') {
      value = 0;
      parts = { datetime: '', ms: '000' };
      lastSyncSource = 'numeric';
    }
  };

  // Sync: datetime input -> value -> numeric
  const handleDatetimeInput = (e) => {
    parts = { ...parts, datetime: e.target.value };
    const ts = partsToTs(e.target.value, parts.ms);
    value = ts;
    numericInput = ts > 0 ? String(ts) : '';
    lastSyncSource = 'datetime';
  };

  // Sync: ms input -> value -> numeric
  const handleMsInput = (e) => {
    const raw = e.target.value.replace(/[^0-9]/g, '').slice(0, 3);
    parts = { ...parts, ms: raw };
    const ts = partsToTs(parts.datetime, raw);
    value = ts;
    numericInput = ts > 0 ? String(ts) : '';
    lastSyncSource = 'ms';
  };

  // External value change (e.g., preset button) — sync both representations
  $effect(() => {
    if (lastSyncSource === null || lastSyncSource === 'external') {
      parts = tsToDatetimeParts(value);
      numericInput = value > 0 ? String(value) : '';
    }
    // Reset sync source after propagation
    lastSyncSource = null;
  });

  // "Now" helper
  const setNow = () => {
    const now = Date.now();
    const capped = max !== null ? Math.min(now, max) : now;
    value = capped;
    parts = tsToDatetimeParts(capped);
    numericInput = String(capped);
    lastSyncSource = 'external';
  };
</script>

<div class="space-y-3">
  <p class="text-sm font-medium text-gray-700">{label}</p>

  <!-- Numeric Unix timestamp input -->
  <div>
    <div class="flex items-center gap-2">
      <label for="ts-numeric" class="text-xs text-gray-500 w-28 shrink-0"
        >Unix timestamp (ms)</label
      >
      <input
        id="ts-numeric"
        type="text"
        inputmode="numeric"
        value={numericInput}
        oninput={handleNumericInput}
        {disabled}
        placeholder="e.g. 1711324800000"
        class="block w-full rounded border-gray-300 shadow-sm text-sm px-3 py-2 border
          font-mono {validationError ? 'border-red-300 focus:border-red-500' : 'focus:border-blue-500'}"
      />
      <button
        type="button"
        onclick={setNow}
        {disabled}
        class="shrink-0 px-2.5 py-2 text-xs bg-gray-100 text-gray-600
          border border-gray-300 rounded hover:bg-gray-200 disabled:opacity-50"
      >
        Now
      </button>
    </div>
  </div>

  <!-- UTC datetime input with ms -->
  <div>
    <div class="flex items-center gap-2">
      <label for="ts-datetime" class="text-xs text-gray-500 w-28 shrink-0"
        >UTC date/time</label
      >
      <input
        id="ts-datetime"
        type="datetime-local"
        step="1"
        value={parts.datetime}
        oninput={handleDatetimeInput}
        {disabled}
        class="block w-full rounded border-gray-300 shadow-sm text-sm px-3 py-2 border
          {validationError ? 'border-red-300 focus:border-red-500' : 'focus:border-blue-500'}"
      />
      <span class="text-gray-400 text-xs">.</span>
      <input
        type="text"
        inputmode="numeric"
        maxlength="3"
        value={parts.ms}
        oninput={handleMsInput}
        {disabled}
        placeholder="000"
        class="w-14 rounded border-gray-300 shadow-sm text-sm px-2 py-2 border
          font-mono text-center {validationError ? 'border-red-300' : ''}"
      />
      <span class="text-xs text-gray-400">ms</span>
    </div>
  </div>

  <!-- Live preview -->
  {#if value > 0}
    <p class="text-xs text-gray-400 pl-30">
      = {new Date(value).toISOString()}
    </p>
  {/if}

  <!-- Validation feedback -->
  {#if validationError}
    <p class="text-xs text-red-600">{validationError}</p>
  {/if}
</div>
