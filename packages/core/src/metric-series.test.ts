// The series key's work count: built once per label set a request carries, never once per
// instrument the set is handed to. Pinned by counting `JSON.stringify`, the key's one cost.

import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { collectMetrics, counter, resetMetrics } from './metrics';
import { recordRequest } from './runtime-metrics';

afterEach(() => {
  resetMetrics();
});

/** `JSON.stringify` calls made by `work`, the series key's whole cost. */
function stringifies(work: () => void): number {
  const spy = spyOn(JSON, 'stringify');
  try {
    work();
    return spy.mock.calls.length;
  } finally {
    spy.mockRestore();
  }
}

describe('series key work count', () => {
  test('recordRequest builds one key for its two instruments, not one each', () => {
    const count = stringifies(() =>
      recordRequest({ method: 'GET', route: '/work-count/first', status: 200, durationMs: 3 }),
    );
    expect(count).toBe(1);
  });

  test('a repeated (method, route, class) builds no key at all', () => {
    const sample = { method: 'GET', route: '/work-count/repeat', status: 204, durationMs: 1 };
    recordRequest(sample);
    const count = stringifies(() => {
      for (let i = 0; i < 100; i += 1) recordRequest({ ...sample, status: 200 + (i % 2) });
    });
    expect(count).toBe(0);
    const point = collectMetrics()
      .metrics.find((metric) => metric.descriptor.name === 'http_requests_total')
      ?.points.find((p) => p.attributes['route'] === '/work-count/repeat');
    expect(point?.value).toBe(101);
  });

  test('a frozen label set is keyed once, wherever it is handed', () => {
    const hits = counter('work_count_frozen_total');
    const labels = Object.freeze({ b: 'two', a: 'one' });
    const count = stringifies(() => {
      for (let i = 0; i < 10; i += 1) hits.add(1, labels);
    });
    expect(count).toBe(1);
  });

  test('a mutable label set is keyed every call: a mutation lands on its own series', () => {
    const hits = counter('work_count_mutable_total');
    const labels: Record<string, string> = { a: 'one' };
    hits.add(1, labels);
    labels['a'] = 'two';
    hits.add(1, labels);
    const points =
      collectMetrics().metrics.find(
        (metric) => metric.descriptor.name === 'work_count_mutable_total',
      )?.points ?? [];
    expect(points.map((p) => [p.attributes['a'], p.value])).toEqual([
      ['one', 1],
      ['two', 1],
    ]);
  });
});
