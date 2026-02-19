<script>
  let { backups = [], ondelete, onrestore } = $props();

  const formatDate = (ts) => {
    if (!ts) return 'N/A';
    return new Date(ts).toLocaleString();
  };
</script>

{#if backups.length === 0}
  <p class="text-gray-500 text-sm">No backups available.</p>
{:else}
  <div class="overflow-x-auto">
    <table class="min-w-full divide-y divide-gray-200">
      <thead class="bg-gray-50">
        <tr>
          <th
            class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase"
            >Backup ID</th
          >
          <th
            class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase"
            >Created</th
          >
          <th
            class="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase"
            >Event Timestamp</th
          >
          <th
            class="px-4 py-2 text-right text-xs font-medium text-gray-500 uppercase"
            >Actions</th
          >
        </tr>
      </thead>
      <tbody class="bg-white divide-y divide-gray-200">
        {#each backups as backup}
          <tr>
            <td class="px-4 py-2 text-sm font-mono text-gray-900"
              >{backup.backupId}</td
            >
            <td class="px-4 py-2 text-sm text-gray-600"
              >{formatDate(backup.timestamp)}</td
            >
            <td class="px-4 py-2 text-sm text-gray-600"
              >{formatDate(backup.eventTimestamp)}</td
            >
            <td class="px-4 py-2 text-right space-x-2">
              {#if onrestore}
                <button
                  onclick={() => onrestore(backup.backupId)}
                  class="text-sm text-blue-600 hover:text-blue-800"
                  >Restore</button
                >
              {/if}
              {#if ondelete}
                <button
                  onclick={() => ondelete(backup.backupId)}
                  class="text-sm text-red-600 hover:text-red-800"
                  >Delete</button
                >
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}
