/**
 * Create a command sender that POSTs commands as JSON to a remote command
 * processor.
 *
 * @param {object} opts
 * @param {string} opts.url - Endpoint URL.
 * @param {string|Function} [opts.jwt] - Bearer token (or sync/async function
 *   returning one) for the Authorization header.
 * @param {number} [opts.fetchTimeoutMs=5000] - Per-request timeout in
 *   milliseconds. Wired into every fetch call as `AbortSignal.timeout(N)` to
 *   prevent hangs against unresponsive endpoints.
 */
export const commandSenderFetch = ({ url, jwt, fetchTimeoutMs = 5000 }) => ({
  sendCommand: (correlationId, cmd) => {
    cmd.correlationId = correlationId;
    return Promise.resolve(typeof jwt === 'function' ? jwt() : jwt).then(
      (token) => {
        const headers = { 'Content-Type': 'application/json' };
        if (token) {
          headers.Authorization = `Bearer ${token}`;
        }
        return fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(cmd),
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
