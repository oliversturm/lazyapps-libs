const isTimestampZero = (lastProjectedEventTimestamp) =>
  !lastProjectedEventTimestamp || lastProjectedEventTimestamp === 0;

const getPreflightStatus = (rmStatus, lastEventStoreTimestamp) => {
  if (!rmStatus) {
    return { found: false, tzero: false, lastEventStoreTimestamp: null };
  }

  const tzero = isTimestampZero(rmStatus.lastProjectedEventTimestamp);

  return {
    found: true,
    tzero,
    lastProjectedEventTimestamp: rmStatus.lastProjectedEventTimestamp || 0,
    lastEventStoreTimestamp:
      lastEventStoreTimestamp !== undefined && lastEventStoreTimestamp !== null
        ? lastEventStoreTimestamp
        : null,
    state: rmStatus.state,
  };
};

export { getPreflightStatus, isTimestampZero };

export const __testing__ = { isTimestampZero };
