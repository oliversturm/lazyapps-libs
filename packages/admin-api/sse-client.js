import { getLogger } from '@lazyapps/logger';
import { EventEmitter } from 'events';

const parseSseChunk = (chunk) => {
  let eventType = null;
  let eventData = null;
  chunk.split('\n').forEach((line) => {
    if (line.startsWith('event: ')) eventType = line.slice(7);
    if (line.startsWith('data: ')) eventData = line.slice(6);
  });
  if (eventType && eventData) {
    try {
      return { type: eventType, data: JSON.parse(eventData) };
    } catch {
      return null;
    }
  }
  return null;
};

const createSseSubscription = (url, token, onEvent, onError) => {
  const log = getLogger('Admin/SSE', 'SUB');
  let closed = false;
  let controller = null;
  let retryDelay = 1000;
  let retryTimer = null;
  const maxRetryDelay = 30000;

  const connect = () => {
    if (closed) return;

    controller = new AbortController();
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;

    log.debug(`Connecting to SSE: ${url}`);

    fetch(url, { signal: controller.signal, headers })
      .then((response) => {
        if (!response.ok) {
          log.warn(
            `SSE connection failed: HTTP ${response.status} from ${url}`,
          );
          scheduleReconnect();
          return;
        }

        retryDelay = 1000;
        log.info(`SSE connected: ${url}`);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        const read = () => {
          reader
            .read()
            .then(({ done, value }) => {
              if (done || closed) {
                if (!closed) scheduleReconnect();
                return;
              }
              buffer += decoder.decode(value, { stream: true });

              const parts = buffer.split('\n\n');
              buffer = parts.pop();

              parts.forEach((part) => {
                const parsed = parseSseChunk(part);
                if (parsed) onEvent(parsed);
              });

              read();
            })
            .catch((err) => {
              if (closed || err.name === 'AbortError') return;
              if (!closed) scheduleReconnect();
            });
        };
        read();
      })
      .catch((err) => {
        if (closed) return;
        log.warn(`SSE connection error for ${url}: ${err.message}`);
        if (onError) onError(err);
        scheduleReconnect();
      });
  };

  const scheduleReconnect = () => {
    if (closed) return;
    log.debug(`Reconnecting to ${url} in ${retryDelay}ms`);
    retryTimer = setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, maxRetryDelay);
  };

  const close = () => {
    closed = true;
    if (retryTimer) clearTimeout(retryTimer);
    if (controller) controller.abort();
  };

  connect();

  return { close };
};

const createStatusCache = () => {
  const data = {
    readModels: {},
    commandProcessor: {
      state: 'idle',
      activeReplays: [],
      activeCatchUps: [],
    },
  };

  const updateReadModel = (status) => {
    const key = `${status.endpointName}/${status.readModelName}`;
    data.readModels[key] = status;
  };

  const updateCommandProcessor = (status) => {
    data.commandProcessor = status;
  };

  const getReadModel = (ep, rm) => data.readModels[`${ep}/${rm}`] || null;

  const getAllReadModels = () => ({ ...data.readModels });

  const getCommandProcessor = () => ({ ...data.commandProcessor });

  const get = () => ({
    readModels: { ...data.readModels },
    commandProcessor: { ...data.commandProcessor },
  });

  return {
    updateReadModel,
    updateCommandProcessor,
    getReadModel,
    getAllReadModels,
    getCommandProcessor,
    get,
  };
};

const createSseClient = ({
  readModelServiceUrl,
  commandProcessorUrl,
  token,
}) => {
  const log = getLogger('Admin/SSE', 'CLIENT');
  const emitter = new EventEmitter();
  const cache = createStatusCache();
  const subscriptions = [];
  let browserClients = 0;
  let activeOperations = 0;
  let connected = false;

  const getServiceUrls = () => {
    if (typeof readModelServiceUrl === 'string') {
      return [readModelServiceUrl];
    }
    if (typeof readModelServiceUrl === 'object' && readModelServiceUrl) {
      return [...new Set(Object.values(readModelServiceUrl))];
    }
    return [];
  };

  const getEndpointNames = () => {
    if (typeof readModelServiceUrl === 'object' && readModelServiceUrl) {
      return Object.keys(readModelServiceUrl);
    }
    return [];
  };

  const connectAll = () => {
    if (connected) return Promise.resolve();
    connected = true;

    log.info('Starting SSE subscriptions to RM and CP services');

    // Fetch initial status via HTTP before subscribing to SSE
    return fetchAllStatus().then(() => {
      // Subscribe to RM SSE endpoints
      const serviceUrls = getServiceUrls();
      const epNames = getEndpointNames();

      const subscribeToEps = (eps) => {
        eps.forEach((ep) => {
          const url =
            typeof readModelServiceUrl === 'string'
              ? readModelServiceUrl
              : readModelServiceUrl[ep];
          const sub = createSseSubscription(
            `${url}/admin/events/${ep}`,
            token,
            (event) => {
              if (event.type === 'status-change') {
                cache.updateReadModel(event.data);
                emitter.emit('readmodel-status', event.data);
                emitter.emit('status-change', cache.get());
              }
            },
          );
          subscriptions.push(sub);
        });
      };

      // Subscribe to CP SSE endpoint
      const subscribeToCp = () => {
        if (commandProcessorUrl) {
          const sub = createSseSubscription(
            `${commandProcessorUrl}/admin/commandprocessor/events`,
            token,
            (event) => {
              if (event.type === 'status-change') {
                cache.updateCommandProcessor(event.data);
                emitter.emit('commandprocessor-status', event.data);
                emitter.emit('status-change', cache.get());
              }
            },
          );
          subscriptions.push(sub);
        }
      };

      subscribeToCp();

      if (typeof readModelServiceUrl === 'string') {
        // Single URL — discover endpoint names from cache.
        // If cache is empty (service not ready yet), retry with backoff.
        // Returns a Promise that resolves when subscriptions are established.
        const discoverAndSubscribe = (attempt, delay) => {
          const knownEps = new Set();
          Object.values(cache.getAllReadModels()).forEach((rm) => {
            if (rm.endpointName) knownEps.add(rm.endpointName);
          });
          if (knownEps.size > 0) {
            subscribeToEps(knownEps);
            return Promise.resolve();
          }
          if (attempt >= 15) {
            log.warn(
              'Could not discover RM endpoints for SSE after 15 attempts',
            );
            return Promise.resolve();
          }
          log.debug(
            `No RM endpoints discovered yet (attempt ${attempt + 1}/15), retrying in ${delay}ms`,
          );
          return new Promise((resolve) => {
            setTimeout(
              () =>
                fetchAllStatus()
                  .then(() =>
                    discoverAndSubscribe(
                      attempt + 1,
                      Math.min(delay * 2, 30000),
                    ),
                  )
                  .then(resolve),
              delay,
            );
          });
        };
        return discoverAndSubscribe(0, 1000);
      } else if (typeof readModelServiceUrl === 'object') {
        subscribeToEps(epNames);
      }
    });
  };

  const disconnectAll = () => {
    if (!connected) return;
    connected = false;
    log.info('Closing all SSE subscriptions');
    subscriptions.forEach((sub) => sub.close());
    subscriptions.length = 0;
  };

  const fetchAllStatus = () => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const rmPromises = getServiceUrls().map((baseUrl) =>
      fetch(`${baseUrl}/admin/readmodel`, { headers })
        .then((r) => (r.ok ? r.json() : []))
        .then((rms) => {
          rms.forEach((rm) => {
            if (rm.name && rm.endpointName) {
              cache.updateReadModel({
                endpointName: rm.endpointName,
                readModelName: rm.name,
                state: rm.state || 'stopped',
                lastProjectedEventTimestamp:
                  rm.lastProjectedEventTimestamp || 0,
              });
            }
          });
        })
        .catch((err) => {
          log.warn(`Failed to fetch RM status from ${baseUrl}: ${err.message}`);
        }),
    );

    const cpPromise = commandProcessorUrl
      ? fetch(`${commandProcessorUrl}/admin/commandprocessor/status`, {
          headers,
        })
          .then((r) => (r.ok ? r.json() : null))
          .then((status) => {
            if (status) cache.updateCommandProcessor(status);
          })
          .catch((err) => {
            log.warn(`Failed to fetch CP status: ${err.message}`);
          })
      : Promise.resolve();

    return Promise.all([...rmPromises, cpPromise]);
  };

  const ensureConnected = () => {
    if (!connected) return connectAll();
    return Promise.resolve();
  };

  const addBrowserClient = () => {
    browserClients++;
    return ensureConnected();
  };

  const removeBrowserClient = () => {
    browserClients = Math.max(0, browserClients - 1);
  };

  const startOperation = () => {
    activeOperations++;
    return ensureConnected();
  };

  const endOperation = () => {
    activeOperations = Math.max(0, activeOperations - 1);
  };

  const waitForStatus = (predicate, timeoutMs = 10000) =>
    new Promise((resolve, reject) => {
      const current = cache.get();
      if (predicate(current)) return resolve(current);

      const timer = setTimeout(() => {
        emitter.off('status-change', handler);
        reject(new Error('Status wait timeout'));
      }, timeoutMs);

      const handler = (status) => {
        if (predicate(status)) {
          clearTimeout(timer);
          emitter.off('status-change', handler);
          resolve(status);
        }
      };
      emitter.on('status-change', handler);
    });

  const fetchReplayRelevantEvents = (ep, rm) => {
    const urls = getServiceUrls();
    const baseUrl =
      typeof readModelServiceUrl === 'object'
        ? readModelServiceUrl[ep] || urls[0]
        : urls[0];
    if (!baseUrl) {
      return Promise.reject(new Error('No RM service URL configured'));
    }

    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    return fetch(`${baseUrl}/admin/replayRelevantEvents/${ep}/${rm}`, {
      headers,
    }).then((r) => {
      if (!r.ok) {
        throw new Error(
          `Failed to fetch replayRelevantEvents: HTTP ${r.status}`,
        );
      }
      return r.json();
    });
  };

  const fetchBackupList = (ep, rm) => {
    const urls = getServiceUrls();
    const baseUrl =
      typeof readModelServiceUrl === 'object'
        ? readModelServiceUrl[ep] || urls[0]
        : urls[0];
    if (!baseUrl) {
      return Promise.reject(new Error('No RM service URL configured'));
    }

    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    return fetch(`${baseUrl}/admin/backup/list/${ep}/${rm}`, { headers }).then(
      (r) => {
        if (!r.ok) {
          throw new Error(`Failed to fetch backup list: HTTP ${r.status}`);
        }
        return r.json();
      },
    );
  };

  return {
    cache,
    emitter,
    addBrowserClient,
    removeBrowserClient,
    startOperation,
    endOperation,
    ensureConnected,
    disconnectAll,
    waitForStatus,
    fetchReplayRelevantEvents,
    fetchBackupList,
    fetchAllStatus,
    getServiceUrls,
  };
};

export { createSseClient, createStatusCache, parseSseChunk };
