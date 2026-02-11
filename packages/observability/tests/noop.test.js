import { describe, test, expect } from 'vitest';
import { trace, metrics, context } from '@opentelemetry/api';

describe('noop behavior without SDK', () => {
  test('trace.getTracer returns a noop tracer', () => {
    const tracer = trace.getTracer('test-noop');
    expect(tracer).toBeDefined();
    expect(typeof tracer.startSpan).toBe('function');
    expect(typeof tracer.startActiveSpan).toBe('function');
  });

  test('noop tracer creates noop spans that can be ended without error', () => {
    const tracer = trace.getTracer('test-noop');
    const span = tracer.startSpan('test-span');
    expect(span).toBeDefined();
    expect(typeof span.end).toBe('function');
    expect(typeof span.setAttribute).toBe('function');
    expect(typeof span.recordException).toBe('function');
    expect(typeof span.setStatus).toBe('function');
    span.end();
  });

  test('noop startActiveSpan executes callback and returns its result', () => {
    const tracer = trace.getTracer('test-noop');
    const result = tracer.startActiveSpan('test-span', (span) => {
      span.setAttribute('key', 'value');
      span.end();
      return 'result';
    });
    expect(result).toBe('result');
  });

  test('noop startActiveSpan works with promise chains', () => {
    const tracer = trace.getTracer('test-noop');
    return tracer
      .startActiveSpan('test-span', (span) =>
        Promise.resolve('async-result')
          .then((val) => {
            span.setAttribute('key', val);
            return val;
          })
          .then((val) => {
            span.end();
            return val;
          }),
      )
      .then((result) => {
        expect(result).toBe('async-result');
      });
  });

  test('metrics.getMeter returns a noop meter', () => {
    const meter = metrics.getMeter('test-noop');
    expect(meter).toBeDefined();
    expect(typeof meter.createCounter).toBe('function');
    expect(typeof meter.createHistogram).toBe('function');
  });

  test('noop counter add does not throw', () => {
    const meter = metrics.getMeter('test-noop');
    const counter = meter.createCounter('test.counter');
    expect(() => counter.add(1, { key: 'value' })).not.toThrow();
  });

  test('noop histogram record does not throw', () => {
    const meter = metrics.getMeter('test-noop');
    const histogram = meter.createHistogram('test.histogram');
    expect(() => histogram.record(42, { key: 'value' })).not.toThrow();
  });

  test('context.active returns a valid context', () => {
    const ctx = context.active();
    expect(ctx).toBeDefined();
  });

  test('trace.getActiveSpan returns undefined when no span is active', () => {
    const span = trace.getActiveSpan();
    expect(span).toBeUndefined();
  });
});
