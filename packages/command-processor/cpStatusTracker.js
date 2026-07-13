import { getLogger } from '@lazyapps/logger';

export const createCpStatusTracker = () => {
  const log = getLogger('CP/Status', 'SYS');
  const activeReplays = new Map();
  const activeCatchUps = new Map();
  const sseClients = new Set();

  // Live-detail counters (issue #15 B). The CP is always live; these give an
  // operator proof of health beyond the status badge.
  const startedAt = Date.now();
  let commandsProcessed = 0;
  let eventsWritten = 0;
  let lastCommandAt = null;
  let lastEventTimestamp = null;
  let recentReplays = []; // most-recent-first, bounded
  const MAX_RECENT_REPLAYS = 5;

  let debounceTimer = null;
  let eventsSinceLastPush = 0;
  const DEBOUNCE_MS = 100;
  const DEBOUNCE_EVENTS = 100;

  const getStatus = () => {
    const replays = [...activeReplays.values()];
    const catchUps = [...activeCatchUps.values()];
    return {
      // 'live' is the CP's resting state — it is always running and accepting
      // commands. 'replaying'/'catching-up' are the transient busy states.
      // (The admin cache uses a separate 'unknown' placeholder before it has
      // heard from the CP — see issue #15.)
      state:
        replays.length > 0
          ? 'replaying'
          : catchUps.length > 0
            ? 'catching-up'
            : 'live',
      startedAt,
      commandsProcessed,
      eventsWritten,
      lastCommandAt,
      lastEventTimestamp,
      recentReplays: [...recentReplays],
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

  // Record a live command/event. In this framework each successfully
  // processed command produces exactly one event (handleCommand throws if
  // none), so a single publishEvent hook advances both counters; failed
  // commands write no event and are intentionally not counted here.
  const trackLiveEvent = (eventTimestamp) => {
    commandsProcessed++;
    eventsWritten++;
    lastCommandAt = Date.now();
    lastEventTimestamp = eventTimestamp;
    schedulePush();
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
    const entry = activeReplays.get(key);
    if (entry) {
      // Record a trailing summary so an operator can confirm a replay ran
      // without having to catch the badge mid-flash (issue #15 B).
      recentReplays = [
        {
          readModel,
          targetEndpointName,
          eventsSent: entry.eventsSent,
          completedAt: Date.now(),
        },
        ...recentReplays,
      ].slice(0, MAX_RECENT_REPLAYS);
    }
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
    trackLiveEvent,
    trackReplayStart,
    trackReplayEvent,
    trackReplayEnd,
    trackCatchUpStart,
    trackCatchUpEvent,
    trackCatchUpSetToTimestamp,
    trackCatchUpEnd,
  };
};
