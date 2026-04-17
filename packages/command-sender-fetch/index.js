export const commandSenderFetch = ({ url, jwt }) => ({
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
