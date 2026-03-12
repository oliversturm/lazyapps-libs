import { describe, test, expect } from 'vitest';
import { subjectLifecycleAggregate } from '../subjectLifecycle.js';

describe('subjectLifecycleAggregate', () => {
  describe('initial', () => {
    test('returns empty object', () => {
      expect(subjectLifecycleAggregate.initial()).toEqual({});
    });
  });

  describe('commands.FORGET_SUBJECT', () => {
    const command = subjectLifecycleAggregate.commands.FORGET_SUBJECT;

    test('returns SUBJECT_FORGOTTEN event with valid payload', () => {
      const aggregate = {};
      const payload = {
        subjectId: 'cust-42',
        subjectType: 'customer',
        reason: 'GDPR request',
        requestedBy: 'admin',
      };
      const result = command(aggregate, payload);
      expect(result).toEqual({
        type: 'SUBJECT_FORGOTTEN',
        payload,
      });
    });

    test('throws ValidationError when subjectId is missing', () => {
      const aggregate = {};
      expect(() => command(aggregate, {})).toThrow('Missing subjectId');
      try {
        command(aggregate, {});
      } catch (err) {
        expect(err.name).toBe('ValidationError');
      }
    });

    test('throws ValidationError when subject already forgotten', () => {
      const aggregate = { forgotten: true };
      const payload = { subjectId: 'cust-42' };
      expect(() => command(aggregate, payload)).toThrow(
        'already been forgotten',
      );
      try {
        command(aggregate, payload);
      } catch (err) {
        expect(err.name).toBe('ValidationError');
      }
    });
  });

  describe('double-forget rejection', () => {
    test('rejects second forget after projection marks aggregate as forgotten', () => {
      const command = subjectLifecycleAggregate.commands.FORGET_SUBJECT;
      const projection =
        subjectLifecycleAggregate.projections.SUBJECT_FORGOTTEN;

      const payload = {
        subjectId: 'cust-42',
        subjectType: 'customer',
        reason: 'GDPR request',
        requestedBy: 'admin',
      };

      // First forget succeeds
      let aggregate = subjectLifecycleAggregate.initial();
      const event = command(aggregate, payload);
      expect(event.type).toBe('SUBJECT_FORGOTTEN');

      // Apply projection to aggregate state
      aggregate = projection(aggregate, {
        ...event,
        timestamp: Date.now(),
      });
      expect(aggregate.forgotten).toBe(true);

      // Second forget is rejected
      expect(() => command(aggregate, payload)).toThrow(
        'already been forgotten',
      );
      try {
        command(aggregate, payload);
      } catch (err) {
        expect(err.name).toBe('ValidationError');
      }
    });
  });

  describe('projections.SUBJECT_FORGOTTEN', () => {
    const projection = subjectLifecycleAggregate.projections.SUBJECT_FORGOTTEN;

    test('sets forgotten true and forgottenAt from event timestamp', () => {
      const aggregate = {};
      const event = { timestamp: 1700000000000, payload: {} };
      const result = projection(aggregate, event);
      expect(result).toEqual({
        forgotten: true,
        forgottenAt: 1700000000000,
      });
    });

    test('uses event.timestamp not payload.timestamp', () => {
      const aggregate = {};
      const event = {
        timestamp: 1700000000000,
        payload: { timestamp: 9999999999999 },
      };
      const result = projection(aggregate, event);
      expect(result.forgottenAt).toBe(1700000000000);
    });

    test('preserves existing aggregate state', () => {
      const aggregate = { someField: 'value', count: 5 };
      const event = { timestamp: 1700000000000, payload: {} };
      const result = projection(aggregate, event);
      expect(result).toEqual({
        someField: 'value',
        count: 5,
        forgotten: true,
        forgottenAt: 1700000000000,
      });
    });
  });
});
