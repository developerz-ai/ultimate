// What one span costs when nothing will ever read it (plan 101 slice 20): an UNSAMPLED span, and a
// sampled one with no `span.end` subscriber. The target is ≤ 1 µs per unsampled span — every
// statement, action and render opens one in production. Timed here for the result line only;
// the test beside it holds the COUNTS (clock reads, random draws, dispatches), which cannot flake.

import {
  alwaysOffSampler,
  alwaysOnSampler,
  type Clock,
  configureTelemetry,
  resetTelemetry,
  systemClock,
  withSpan,
} from '../../packages/core/src/index';
import { parseScriptArgs } from '../lib/args';
import { boxFacts } from './http-hello';

/** The ceiling the plan sets: one span may cost an emitter at most this, unsampled. */
export const UNSAMPLED_SPAN_TARGET_NS = 1_000;

/** A clock that counts its reads — the cost an unsampled span should never pay. */
export function countingClock(): Clock & { reads(): number } {
  let reads = 0;
  return {
    now() {
      reads += 1;
      return systemClock.now();
    },
    monotonic() {
      reads += 1;
      return systemClock.monotonic();
    },
    reads: () => reads,
  };
}

/** How many times `crypto.getRandomValues` runs inside `work` — every id is one draw. */
export function randomDraws(work: () => void): number {
  const real = crypto.getRandomValues.bind(crypto);
  let draws = 0;
  crypto.getRandomValues = (<T extends ArrayBufferView | null>(array: T): T => {
    draws += 1;
    return real(array);
  }) as typeof crypto.getRandomValues;
  try {
    work();
  } finally {
    crypto.getRandomValues = real;
  }
  return draws;
}

export interface SpanTiming {
  readonly case: 'unsampled root' | 'unsampled child' | 'sampled, no subscriber';
  readonly nsPerSpan: number;
}

function nsPer(iterations: number, work: () => void): number {
  for (let index = 0; index < iterations / 10; index += 1) work();
  const started = Bun.nanoseconds();
  for (let index = 0; index < iterations; index += 1) work();
  return Math.round((Bun.nanoseconds() - started) / iterations);
}

/** Median of `rounds` timed loops per case: a single loop on a shared box is one GC pause away. */
export function benchSpans(iterations = 200_000, rounds = 5): readonly SpanTiming[] {
  const median = (work: () => void): number => {
    const runs = Array.from({ length: rounds }, () => nsPer(iterations, work)).sort(
      (a, b) => a - b,
    );
    return runs[Math.floor(rounds / 2)] ?? 0;
  };
  try {
    configureTelemetry({ sampler: alwaysOffSampler });
    const root = median(() => withSpan('bench.root', () => 0));
    const child = withSpan('bench.parent', () => median(() => withSpan('bench.child', () => 0)));
    configureTelemetry({ sampler: alwaysOnSampler });
    const sampled = median(() => withSpan('bench.sampled', () => 0));
    return [
      { case: 'unsampled root', nsPerSpan: root },
      { case: 'unsampled child', nsPerSpan: child },
      { case: 'sampled, no subscriber', nsPerSpan: sampled },
    ];
  } finally {
    resetTelemetry();
  }
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const results = benchSpans();
  const data = { box: boxFacts(Bun.env), targetNs: UNSAMPLED_SPAN_TARGET_NS, results };
  const out = args.flags.get('out');
  if (typeof out === 'string') await Bun.write(out, `${JSON.stringify(data, null, 2)}\n`);
  if (args.json) console.log(JSON.stringify(data, null, 2));
  else for (const r of results) console.log(`${r.case}: ${r.nsPerSpan} ns per span`);
}
