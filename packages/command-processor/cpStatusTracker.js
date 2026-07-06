import { getLogger } from '@lazyapps/logger';

export const createCpStatusTracker = () => {
  const log = getLogger('CP/Status', 'SYS');
  const activeReplays = new Map();
  const activeCatchUps = new Map();
  const sseClients = new Set();

  let debounceTimer = null;
  let eventsSinceLastPush = 0;
  const DEBOUNCE_MS = 100;
  const DEBOUNCE_EVENTS = 100;

  const getStatus = () => {
    const replays = [...activeReplays.values()];
    const catchUps = [...activeCatchUps.values()];
    return {
      state:
        replays.length > 0
          ? 'replaying'
          : catchUps.length > 0
            ? 'catching-up'
            : 'idle',
      activeReplays: replays.map(
        ({
          readModel,
          targetEndpointName,
          eventsSent,
          lastSentTimestamp,
          correlationId,
        }) => ({
          readModel,
          targetEndpointName,
          eventsSent,
          lastSentTimestamp,
          correlationId,
        }),
      ),
      activeCatchUps: catchUps.map(
        ({
          readModel,
          targetEndpointName,
          eventsSent,
          lastSentTimestamp,
          correlationId,
          toTimestamp,
        }) => ({
          readModel,
          targetEndpointName,
          eventsSent,
          lastSentTimestamp,
          correlationId,
          ...(toTimestamp !== undefined && { toTimestamp }),
        }),
      ),
    };
  };

  const pushStatus = () => {
    const status = getStatus();
    const data = `event: status-change\ndata: ${JSON.stringify(status)}\n\n`;
    sseClients.forEach((res) => {
      res.write(data);
    });
    eventsSinceLastPush = 0;
  };

  const schedulePush = () => {
    eventsSinceLastPush++;
    if (eventsSinceLastPush >= DEBOUNCE_EVENTS) {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      pushStatus();
      return;
    }
    if (!debounceTimer) {
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        pushStatus();
      }, DEBOUNCE_MS);
    }
  };

  const forcePush = () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    pushStatus();
  };

  const replayKey = (readModel, targetEndpointName) =>
    `${readModel}/${targetEndpointName || '_'}`;

  const trackReplayStart = (readModel, targetEndpointName, correlationId) => {
    const key = replayKey(readModel, targetEndpointName);
    activeReplays.set(key, {
      readModel,
      targetEndpointName,
      eventsSent: 0,
      lastSentTimestamp: 0,
      correlationId,
    });
    log.info(`Replay started: ${key}`);
    forcePush();
  };

  const trackReplayEvent = (readModel, targetEndpointName, eventTimestamp) => {
    const key = replayKey(readModel, targetEndpointName);
    const entry = activeReplays.get(key);
    if (entry) {
      entry.eventsSent++;
      entry.lastSentTimestamp = eventTimestamp;
      schedulePush();
    }
  };

  const trackReplayEnd = (readModel, targetEndpointName) => {
    const key = replayKey(readModel, targetEndpointName);
    activeReplays.delete(key);
    log.info(`Replay ended: ${key}`);
    forcePush();
  };

  const trackCatchUpStart = (readModel, targetEndpointName, correlationId) => {
    const key = replayKey(readModel, targetEndpointName);
    activeCatchUps.set(key, {
      readModel,
      targetEndpointName,
      eventsSent: 0,
      lastSentTimestamp: 0,
      correlationId,
    });
    log.info(`Catch-up started: ${key}`);
    forcePush();
  };

  const trackCatchUpEvent = (readModel, targetEndpointName, eventTimestamp) => {
    const key = replayKey(readModel, targetEndpointName);
    const entry = activeCatchUps.get(key);
    if (entry) {
      entry.eventsSent++;
      entry.lastSentTimestamp = eventTimestamp;
      schedulePush();
    }
  };

  const trackCatchUpSetToTimestamp = (
    readModel,
    targetEndpointName,
    toTimestamp,
  ) => {
    const key = replayKey(readModel, targetEndpointName);
    const entry = activeCatchUps.get(key);
    if (entry) {
      entry.toTimestamp = toTimestamp;
    }
  };

  const trackCatchUpEnd = (readModel, targetEndpointName) => {
    const key = replayKey(readModel, targetEndpointName);
    activeCatchUps.delete(key);
    log.info(`Catch-up ended: ${key}`);
    forcePush();
  };

  const addSseClient = (res) => {
    sseClients.add(res);
    // Send the current status so a newly connected client doesn't miss
    // transitions that happened before its stream was established
    const status = getStatus();
    res.write(`event: status-change\ndata: ${JSON.stringify(status)}\n\n`);
    log.debug(
      `SSE client connected, sent status snapshot (state=${status.state})`,
    );
  };

  const removeSseClient = (res) => {
    sseClients.delete(res);
  };

  return {
    getStatus,
    addSseClient,
    removeSseClient,
    trackReplayStart,
    trackReplayEvent,
    trackReplayEnd,
    trackCatchUpStart,
    trackCatchUpEvent,
    trackCatchUpSetToTimestamp,
    trackCatchUpEnd,
  };
};
