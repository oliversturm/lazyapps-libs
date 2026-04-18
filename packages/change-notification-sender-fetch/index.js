/**
 * Create a change-notification sender that POSTs notifications as JSON to a
 * remote change notifier.
 *
 * @param {object} opts
 * @param {string} opts.url - Endpoint URL.
 * @param {string|Function} [opts.jwt] - Bearer token (or sync/async function
 *   returning one) for the Authorization header.
 * @param {number} [opts.fetchTimeoutMs=5000] - Per-request timeout in
 *   milliseconds. Wired into every fetch call as `AbortSignal.timeout(N)` to
 *   prevent hangs against unresponsive endpoints.
 */
export const changeNotificationSenderFetch = ({
  url,
  jwt,
  fetchTimeoutMs = 5000,
}) => ({
  sendChangeNotification: (correlationId, content) => {
    content.correlationId = correlationId;
    return Promise.resolve(typeof jwt === 'function' ? jwt() : jwt).then(
      (token) => {
        const headers = { 'Content-Type': 'application/json' };
        if (token) {
          headers.Authorization = `Bearer ${token}`;
        }
        return fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(content),
          signal: AbortSignal.timeout(fetchTimeoutMs),
        }).then((res) => {
          if (!res.ok) {
            throw new Error(
              `[${correlationId}] Fetch error: ${res.status}/${res.statusText}`,
            );
          }
          return res;
        });
      },
    );
  },
});
