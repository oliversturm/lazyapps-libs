import { writable } from 'svelte/store';

const createStatusStore = () => {
  const { subscribe, set, update } = writable({
    readModels: [],
    commandProcessor: {
      state: 'unknown',
      activeReplays: [],
      activeCatchUps: [],
    },
    connected: false,
  });

  const setConnected = (connected) => {
    update((s) => ({ ...s, connected }));
  };

  const updateReadModelStatus = (data) => {
    update((s) => {
      const readModels = [...s.readModels];
      const name = data.readModelName || data.name;
      const normalized = { ...data, name, readModelName: name };
      const idx = readModels.findIndex(
        (rm) =>
          (rm.readModelName || rm.name) === name &&
          rm.endpointName === data.endpointName,
      );
      if (idx >= 0) {
        readModels[idx] = { ...readModels[idx], ...normalized };
      } else {
        readModels.push(normalized);
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
