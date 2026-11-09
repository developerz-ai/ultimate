// An unsampled span's cost, held as COUNTS — clock reads, random draws, bus dispatches — never as
// wall-clock ns: a count cannot flake on a shared runner, and each one is a cost the ≤ 1 µs target
// (`span-overhead.bench.ts`) says an unsampled span must not pay. The timed figure is the result
// line in `results/span-overhead.json`.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  alwaysOffSampler,
  configureTelemetry,
  resetInstrumentation,
  resetTelemetry,
  subscribe,
  withSpan,
} from '../../packages/core/src/index';
import { benchSpans, countingClock, randomDraws } from './span-overhead.bench';

afterEach(() => {
  resetTelemetry();
  resetInstrumentation();
});

describe('span overhead, counted', () => {
  test('an unsampled span reaches no span.end subscriber', () => {
    configureTelemetry({ sampler: alwaysOffSampler });
    let delivered = 0;
    subscribe('span.end', () => {
      delivered += 1;
    });
    for (let index = 0; index < 100; index += 1) withSpan('unsampled', () => 0);
    expect(delivered).toBe(0);
  });

  test('a child of an unsampled span is unsampled too — the decision is the trace’s', () => {
    configureTelemetry({ sampler: alwaysOffSampler });
    const flags = withSpan('parent', () => withSpan('child', (span) => span.context.traceFlags));
    expect(flags & 1).toBe(0);
  });

  // Closed 2026-11-09: `telemetry.ts` reads the clock only for a sampled span and mints an
  // unsampled span's id only when something reads it (`spanContext`).
  test('an unsampled span reads no clock', () => {
    const clock = countingClock();
    configureTelemetry({ sampler: alwaysOffSampler, clock });
    withSpan('unsampled', () => 0);
    expect(clock.reads()).toBe(0);
  });

  test('an unsampled CHILD draws no random bytes: its trace id is the parent’s', () => {
    configureTelemetry({ sampler: alwaysOffSampler });
    const draws = withSpan('parent', () => randomDraws(() => withSpan('child', () => 0)));
    expect(draws).toBe(0);
  });

  test('the bench measures every case it reports', () => {
    const results = benchSpans(1_000, 1);
    expect(results.map((result) => result.case)).toEqual([
      'unsampled root',
      'unsampled child',
      'sampled, no subscriber',
    ]);
    for (const result of results) expect(result.nsPerSpan).toBeGreaterThan(0);
  });
});
