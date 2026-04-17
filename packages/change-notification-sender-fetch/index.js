export const changeNotificationSenderFetch = ({ url, jwt }) => ({
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
