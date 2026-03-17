import { getLogger } from '@lazyapps/logger';

const DEBOUNCE_INTERVAL_MS = 100;
const DEBOUNCE_EVENT_COUNT = 100;

export const createStatusTracker = (readModels, endpointName) => {
  const log = getLogger('RM/Status', 'SYS');
  const sseClients = new Set();
  const statusChangeListeners = [];
  const status = {};
  let debounceTimers = {};
  let eventCounters = {};

  const initialize = (readModelNames) => {
    readModelNames.forEach((name) => {
      status[name] = {
        endpointName: endpointName || 'default',
        readModelName: name,
        state: 'stopped',
        lastProjectedEventTimestamp:
          readModels[name]?.lastProjectedEventTimestamp || 0,
        correlationId: null,
        replayProgress: null,
        catchupProgress: null,
        backupProgress: { state: 'idle' },
      };
    });
    log.info(`Initialized status tracker for: ${readModelNames.join(', ')}`);
  };

  const getStatus = (readModelName) =>
    status[readModelName] ? { ...status[readModelName] } : null;

  const getAllStatuses = () => Object.values(status).map((s) => ({ ...s }));

  const formatSseEvent = (data) =>
    `event: status-change\ndata: ${JSON.stringify(data)}\n\n`;

  const notifyListeners = (readModelName) => {
    const statusData = status[readModelName];
    if (!statusData) return;
    const snapshot = { ...statusData };
    statusChangeListeners.forEach((listener) => listener(snapshot));
  };

  const pushToClients = (readModelName) => {
    const statusData = status[readModelName];
    if (!statusData) return;
    const message = formatSseEvent(statusData);
    sseClients.forEach((res) => {
      res.write(message);
    });
    notifyListeners(readModelName);
  };

  const debouncedPush = (readModelName) => {
    if (!eventCounters[readModelName]) {
      eventCounters[readModelName] = 0;
    }
    eventCounters[readModelName]++;

    if (eventCounters[readModelName] >= DEBOUNCE_EVENT_COUNT) {
      clearTimeout(debounceTimers[readModelName]);
      eventCounters[readModelName] = 0;
      pushToClients(readModelName);
      return;
    }

    if (!debounceTimers[readModelName]) {
      debounceTimers[readModelName] = setTimeout(() => {
        debounceTimers[readModelName] = null;
        eventCounters[readModelName] = 0;
        pushToClients(readModelName);
      }, DEBOUNCE_INTERVAL_MS);
    }
  };

  const immediatePush = (readModelName) => {
    clearTimeout(debounceTimers[readModelName]);
    debounceTimers[readModelName] = null;
    eventCounters[readModelName] = 0;
    pushToClients(readModelName);
  };

  const updateStatus = (readModelName, updates) => {
    if (!status[readModelName]) return;
    Object.assign(status[readModelName], updates);
  };

  const setState = (readModelName, state, correlationId) => {
    if (!status[readModelName]) return;
    const prev = status[readModelName].state;
    updateStatus(readModelName, { state, correlationId });
    immediatePush(readModelName);
    log.info(
      `Status: ${readModelName} ${prev} -> ${state}` +
        (correlationId ? ` [${correlationId}]` : ''),
    );
  };

  const updateProgress = (readModelName, progressField, progressData) => {
    if (!status[readModelName]) return;
    updateStatus(readModelName, { [progressField]: progressData });
    debouncedPush(readModelName);
  };

  const updateLastProjectedEventTimestamp = (readModelName, timestamp) => {
    if (!status[readModelName]) return;
    status[readModelName].lastProjectedEventTimestamp = timestamp;
  };

  const addSseClient = (res) => {
    sseClients.add(res);
    // Send current status for all RMs on connect
    Object.values(status).forEach((s) => {
      res.write(formatSseEvent(s));
    });
  };

  const removeSseClient = (res) => {
    sseClients.delete(res);
  };

  const onStatusChange = (listener) => {
    statusChangeListeners.push(listener);
  };

  return {
    initialize,
    getStatus,
    getAllStatuses,
    setState,
    updateProgress,
    updateLastProjectedEventTimestamp,
    updateStatus,
    addSseClient,
    removeSseClient,
    onStatusChange,
    immediatePush,
    debouncedPush,
  };
};
