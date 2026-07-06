// Shared test helper: poll until a condition is met.
//
// fn() should return:
//   true        — condition met, stop polling
//   false/falsy — condition not met, keep polling
//   string      — condition not met, string is diagnostic info shown on timeout
//
// Example with diagnostics:
//   waitForCondition(
//     () => fetchStatus().then(s =>
//       s.state === 'live' ? true : `state=${s.state}`
//     ),
//     5000, 100, 'RM → live'
//   )
//
// On timeout: "Timeout (RM → live) after 5000ms — state=idle"

export const waitForCondition = (fn, timeout = 5000, interval = 100, label) => {
  const start = Date.now();
  let lastInfo;
  const poll = () =>
    Promise.resolve()
      .then(fn)
      .then((result) => {
        if (result === true) return;
        if (typeof result === 'string') lastInfo = result;
        if (Date.now() - start > timeout)
          throw new Error(
            `Timeout${label ? ` (${label})` : ''}` +
              ` after ${timeout}ms` +
              (lastInfo ? ` — ${lastInfo}` : ''),
          );
        return new Promise((r) => setTimeout(r, interval)).then(poll);
      });
  return poll();
};
