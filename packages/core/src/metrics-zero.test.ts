// A declared counter is 0 from the moment it is declared, not absent until its first sample.
// Split from `metrics.test.ts` at its line ceiling.
import { afterEach, describe, expect, test } from 'bun:test';
import { collectMetrics, counter, gauge, histogram, resetMetrics } from './metrics';

afterEach(() => {
  resetMetrics();
});

const pointsOf = (name: string) =>
  collectMetrics().metrics.find((metric) => metric.descriptor.name === name)?.points ?? [];

describe('an unsampled instrument', () => {
  // A declared counter with no sample yet had NO series: `channel_frames_dropped_total` was absent
  // from /metrics until the first drop, so `rate()` had nothing to alert on and `absent()` read a
  // healthy node as a missing one. Declared is zero.
  test('a declared counter nothing has added to yet exports 0, with no labels', () => {
    counter('test_never_added_total');
    expect(pointsOf('test_never_added_total')).toEqual([{ attributes: {}, value: 0 }]);
  });

  // The zero stands in for "no series yet", never beside a real one: a labelled counter's first
  // sample replaces it rather than leaving an unlabelled 0 summed into every aggregate.
  test('the zero gives way to the first real series', () => {
    const drops = counter('test_first_sample_total');
    drops.add(2, { reason: 'backpressure' });
    expect(pointsOf('test_first_sample_total')).toEqual([
      { attributes: { reason: 'backpressure' }, value: 2 },
    ]);
  });

  test('a gauge or histogram with no sample still exports nothing — zero is a count, not a level', () => {
    gauge('test_never_set');
    histogram('test_never_recorded_seconds');
    expect(pointsOf('test_never_set')).toEqual([]);
    expect(pointsOf('test_never_recorded_seconds')).toEqual([]);
  });
});
