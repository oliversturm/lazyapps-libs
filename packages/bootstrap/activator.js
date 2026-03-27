import { getLogger } from '@lazyapps/logger';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const createActivator = ({
  sseClient,
  orchestrator,
  token,
  readModelServiceUrl,
}) => {
  const getServiceUrls = () => {
    if (typeof readModelServiceUrl === 'string') {
      return [readModelServiceUrl];
    }
    if (typeof readModelServiceUrl === 'object' && readModelServiceUrl) {
      return [...new Set(Object.values(readModelServiceUrl))];
    }
    return [];
  };

  const fetchReadModels = (log) => {
    const urls = getServiceUrls();
    if (urls.length === 0) {
      return Promise.reject(
        new Error('readModelServiceUrl is required for discovery'),
      );
    }

    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    return Promise.all(
      urls.map((baseUrl) => {
        const url = `${baseUrl}/admin/readmodel`;
        return fetch(url, { headers })
          .then((response) => {
            if (!response.ok) {
              throw new Error(`HTTP ${response.status} from ${url}`);
            }
            return response.json();
          })
          .catch((err) => {
            log.warn(`Failed to query ${url}: ${err.message}`);
            return [];
          });
      }),
    ).then((results) => results.flat());
  };

  const autoActivateAll = () => {
    const log = getLogger('Admin/Activator', 'AUTO');
    const maxAttempts = 15;

    log.info('Auto-activation: discovering read models from services');

    const tryFetch = (attempt, backoff) =>
      fetchReadModels(log).then((rms) => {
        if (rms.length === 0 && attempt < maxAttempts) {
          log.warn(
            `Read model discovery returned empty results (attempt ${attempt}/${maxAttempts}), retrying in ${backoff}ms`,
          );
          return delay(backoff).then(() =>
            tryFetch(attempt + 1, Math.min(backoff * 2, 30000)),
          );
        }
        return rms;
      });

    return tryFetch(1, 1000)
      .then((rms) => {
        if (rms.length === 0) {
          log.error(
            'Read model discovery returned empty results after all retry attempts',
          );
          return;
        }

        const names = rms.map((rm) =>
          rm.endpointName ? `${rm.endpointName}/${rm.name}` : rm.name,
        );
        log.info(`Discovered read models: ${names.join(', ')}`);

        // Seed the SSE client cache with discovered RMs
        rms.forEach((rm) => {
          if (rm.name && rm.endpointName) {
            sseClient.cache.updateReadModel({
              endpointName: rm.endpointName,
              readModelName: rm.name,
              state: rm.state || 'idle',
              lastProjectedEventTimestamp: rm.lastProjectedEventTimestamp || 0,
            });
          }
        });

        // Use orchestrator's activateAll which reads from cache
        return orchestrator.activateAll();
      })
      .then((results) => {
        if (results) {
          log.info('All read models activated');
        }
        return results;
      })
      .catch((err) => {
        log.error(`Auto-activation failed: ${err.message}`);
        throw err;
      });
  };

  return {
    autoActivateAll,
    fetchReadModels: () =>
      fetchReadModels(getLogger('Admin/Activator', 'DISCOVER')),
  };
};
