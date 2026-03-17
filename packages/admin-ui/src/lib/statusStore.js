import { writable } from 'svelte/store';

const createStatusStore = () => {
  const { subscribe, set, update } = writable({
    readModels: [],
    commandProcessor: { state: 'idle', activeReplays: [], activeCatchUps: [] },
    connected: false,
  });

  const setConnected = (connected) => {
    update((s) => ({ ...s, connected }));
  };

  const updateReadModelStatus = (data) => {
    update((s) => {
      const readModels = [...s.readModels];
      const idx = readModels.findIndex(
        (rm) => rm.name === data.name && rm.endpointName === data.endpointName,
      );
      if (idx >= 0) {
        readModels[idx] = { ...readModels[idx], ...data };
      } else {
        readModels.push(data);
      }
      return { ...s, readModels };
    });
  };

  const updateCommandProcessorStatus = (data) => {
    update((s) => ({ ...s, commandProcessor: data }));
  };

  const replaceAllReadModels = (readModels) => {
    update((s) => ({ ...s, readModels }));
  };

  const replaceAll = (data) => {
    update((s) => ({
      ...s,
      readModels: data.readModels || s.readModels,
      commandProcessor: data.commandProcessor || s.commandProcessor,
    }));
  };

  return {
    subscribe,
    set,
    setConnected,
    updateReadModelStatus,
    updateCommandProcessorStatus,
    replaceAllReadModels,
    replaceAll,
  };
};

export { createStatusStore };
