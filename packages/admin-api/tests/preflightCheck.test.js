import { describe, test, expect } from 'vitest';
import {
  getPreflightStatus,
  isTimestampZero,
  __testing__,
} from '../preflightCheck.js';

describe('isTimestampZero', () => {
  test('returns true for 0', () => {
    expect(isTimestampZero(0)).toBe(true);
  });

  test('returns true for undefined', () => {
    expect(isTimestampZero(undefined)).toBe(true);
  });

  test('returns true for null', () => {
    expect(isTimestampZero(null)).toBe(true);
  });

  test('returns false for positive number', () => {
    expect(isTimestampZero(1000)).toBe(false);
  });

  test('returns false for 1', () => {
    expect(isTimestampZero(1)).toBe(false);
  });
});

describe('getPreflightStatus', () => {
  test('returns found=false when rmStatus is null', () => {
    const result = getPreflightStatus(null, 5000);
    expect(result).toEqual({
      found: false,
      tzero: false,
      lastEventStoreTimestamp: null,
    });
  });

  test('returns found=false when rmStatus is undefined', () => {
    const result = getPreflightStatus(undefined, 5000);
    expect(result).toEqual({
      found: false,
      tzero: false,
      lastEventStoreTimestamp: null,
    });
  });

  test('detects T=0 when lastProjectedEventTimestamp is 0', () => {
    const rmStatus = {
      endpointName: 'ep1',
      readModelName: 'customers',
      state: 'stopped',
      lastProjectedEventTimestamp: 0,
    };
    const result = getPreflightStatus(rmStatus, 5000);
    expect(result).toEqual({
      found: true,
      tzero: true,
      lastProjectedEventTimestamp: 0,
      lastEventStoreTimestamp: 5000,
      state: 'stopped',
    });
  });

  test('detects T=0 when lastProjectedEventTimestamp is missing', () => {
    const rmStatus = {
      endpointName: 'ep1',
      readModelName: 'customers',
      state: 'stopped',
    };
    const result = getPreflightStatus(rmStatus, 3000);
    expect(result).toEqual({
      found: true,
      tzero: true,
      lastProjectedEventTimestamp: 0,
      lastEventStoreTimestamp: 3000,
      state: 'stopped',
    });
  });

  test('returns tzero=false for normal timestamp', () => {
    const rmStatus = {
      endpointName: 'ep1',
      readModelName: 'customers',
      state: 'live',
      lastProjectedEventTimestamp: 1000,
    };
    const result = getPreflightStatus(rmStatus, 5000);
    expect(result).toEqual({
      found: true,
      tzero: false,
      lastProjectedEventTimestamp: 1000,
      lastEventStoreTimestamp: 5000,
      state: 'live',
    });
  });

  test('handles null lastEventStoreTimestamp', () => {
    const rmStatus = {
      endpointName: 'ep1',
      readModelName: 'customers',
      state: 'stopped',
      lastProjectedEventTimestamp: 0,
    };
    const result = getPreflightStatus(rmStatus, null);
    expect(result.lastEventStoreTimestamp).toBeNull();
    expect(result.tzero).toBe(true);
  });

  test('handles undefined lastEventStoreTimestamp', () => {
    const rmStatus = {
      endpointName: 'ep1',
      readModelName: 'customers',
      state: 'live',
      lastProjectedEventTimestamp: 500,
    };
    const result = getPreflightStatus(rmStatus, undefined);
    expect(result.lastEventStoreTimestamp).toBeNull();
    expect(result.tzero).toBe(false);
  });

  test('handles lastEventStoreTimestamp of 0', () => {
    const rmStatus = {
      endpointName: 'ep1',
      readModelName: 'customers',
      state: 'stopped',
      lastProjectedEventTimestamp: 0,
    };
    const result = getPreflightStatus(rmStatus, 0);
    expect(result.lastEventStoreTimestamp).toBe(0);
    expect(result.tzero).toBe(true);
  });

  test('preserves state from rmStatus', () => {
    const rmStatus = {
      endpointName: 'ep1',
      readModelName: 'customers',
      state: 'replay',
      lastProjectedEventTimestamp: 100,
    };
    const result = getPreflightStatus(rmStatus, 5000);
    expect(result.state).toBe('replay');
  });
});
