// The process series: declared on the first start and never at import, read through whatever
// source is live, and fed by one sampler whose lag and CPU arithmetic a frozen clock can check.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun ships no directory-removal API, and the fixture directory is this process's own.
import { rm } from 'node:fs/promises';
// why: Bun ships no path API; the browser entry is written inside the package to resolve it.
import { join } from 'node:path';
import { frozenClock } from './clock';
import { collectMetrics, resetMetrics } from './metrics';
import type { HistogramPoint } from './metrics-types';
import type { ProcessReading } from './process-metrics';
import {
  EVENT_LOOP_LAG_BOUNDS,
  EVENT_LOOP_SAMPLE_MS,
  readProcess,
  resetProcessMetrics,
  startProcessMetrics,
} from './process-metrics';

const FIXTURE_DIR = join(import.meta.dir, '..', '.tmp', `process-metrics-${process.pid}`);

let stop: (() => void) | undefined;

afterEach(async () => {
  stop?.();
  stop = undefined;
  resetProcessMetrics();
  resetMetrics();
  await rm(FIXTURE_DIR, { recursive: true, force: true });
});

const reading = (over: Partial<ProcessReading> = {}): ProcessReading => ({
  rss: 100,
  heapUsed: 40,
  heapTotal: 60,
  external: 7,
  cpuSeconds: 2,
  uptimeSeconds: 90,
  ...over,
});

/** The value of an unlabelled series, or of the one carrying `role`. */
function seriesValue(name: string, role?: string): number | undefined {
  const metric = collectMetrics().metrics.find((one) => one.descriptor.name === name);
  const point = metric?.points.find((one) => role === undefined || one.attributes['role'] === role);
  return point?.value;
}

/** A sampler the test fires by hand. */
function manualTimer(): {
  every: (tick: () => void, ms: number) => () => void;
  fire(): void;
  stopped: boolean;
  intervalMs: number;
} {
  const timer = {
    tick: (): void => {},
    stopped: false,
    intervalMs: 0,
    every(tick: () => void, ms: number): () => void {
      timer.tick = tick;
      timer.intervalMs = ms;
      return () => {
        timer.stopped = true;
      };
    },
    fire(): void {
      timer.tick();
    },
  };
  return timer;
}

describe('unit · process metrics', () => {
  test('every gauge reads the live source at collection time, never a value captured at start', () => {
    let current = reading();
    const timer = manualTimer();
    stop = startProcessMetrics({ role: 'worker', read: () => current, every: timer.every });
    expect([
      seriesValue('process_resident_memory_bytes'),
      seriesValue('process_heap_used_bytes'),
      seriesValue('process_heap_total_bytes'),
      seriesValue('process_external_memory_bytes'),
    ]).toEqual([100, 40, 60, 7]);
    current = reading({ rss: 250, heapUsed: 41 });
    expect(seriesValue('process_resident_memory_bytes')).toBe(250);
    expect(seriesValue('process_heap_used_bytes')).toBe(41);
  });

  test('the role is a label on process_info, and the start time is the process, not this call', () => {
    const clock = frozenClock(new Date('2026-10-01T12:00:00Z'));
    stop = startProcessMetrics({
      role: 'scheduler',
      read: () => reading(),
      clock,
      every: manualTimer().every,
    });
    expect(seriesValue('process_info', 'scheduler')).toBe(1);
    // Ninety seconds of uptime before this call: the process started then, not now.
    expect(seriesValue('process_start_time_seconds')).toBe(clock.now().getTime() / 1000 - 90);
  });

  test('the sampler records how LATE the loop ran its timer, never a negative lag', () => {
    const clock = frozenClock(new Date('2026-10-01T12:00:00Z'));
    const timer = manualTimer();
    stop = startProcessMetrics({ role: 'web', read: () => reading(), clock, every: timer.every });
    expect(timer.intervalMs).toBe(EVENT_LOOP_SAMPLE_MS);
    // On time, then 300ms late, then early.
    clock.advance(EVENT_LOOP_SAMPLE_MS);
    timer.fire();
    clock.advance(EVENT_LOOP_SAMPLE_MS + 300);
    timer.fire();
    clock.advance(EVENT_LOOP_SAMPLE_MS - 200);
    timer.fire();
    const lag = collectMetrics().metrics.find(
      (one) => one.descriptor.name === 'process_event_loop_lag_seconds',
    )?.points[0] as HistogramPoint;
    expect(lag.count).toBe(3);
    expect(lag.value).toBeCloseTo(0.3, 6);
    expect([lag.min, lag.max]).toEqual([0, 0.3]);
    expect(lag.bounds).toEqual(EVENT_LOOP_LAG_BOUNDS);
  });

  test('CPU is a counter: the boot is counted at start, a delta per sample, nothing twice', () => {
    let cpuSeconds = 2;
    const timer = manualTimer();
    const read = (): ProcessReading => reading({ cpuSeconds });
    stop = startProcessMetrics({ role: 'web', read, every: timer.every });
    expect(seriesValue('process_cpu_seconds_total')).toBe(2);
    cpuSeconds = 2.5;
    timer.fire();
    expect(seriesValue('process_cpu_seconds_total')).toBe(2.5);
    // A stop and a start — every `x dev` reload — carries on from what is already counted.
    stop();
    cpuSeconds = 3;
    stop = startProcessMetrics({ role: 'web', read, every: manualTimer().every });
    expect(seriesValue('process_cpu_seconds_total')).toBe(3);
  });

  test('stop ends the sampler and a scrape after it reads zero rather than throwing', () => {
    const timer = manualTimer();
    const stopFirst = startProcessMetrics({
      role: 'web',
      read: () => reading(),
      every: timer.every,
    });
    stopFirst();
    expect(timer.stopped).toBe(true);
    expect(seriesValue('process_resident_memory_bytes')).toBe(0);
    // Stopping a boot that was already replaced must not silence the one that replaced it.
    stop = startProcessMetrics({
      role: 'web',
      read: () => reading({ rss: 5 }),
      every: timer.every,
    });
    stopFirst();
    expect(seriesValue('process_resident_memory_bytes')).toBe(5);
  });

  test('a sample interval that is not a positive whole number is refused', () => {
    expect(() =>
      startProcessMetrics({ role: 'web', read: () => reading(), sampleMs: Number.NaN }),
    ).toThrow(/sampleMs/);
    expect(() => startProcessMetrics({ role: 'web', read: () => reading(), sampleMs: 0 })).toThrow(
      /sampleMs/,
    );
  });

  test('readProcess answers this process in bytes and seconds', () => {
    const now = readProcess();
    expect(now.rss).toBeGreaterThan(1024 * 1024);
    expect(now.heapUsed).toBeGreaterThan(0);
    // Never `heapTotal >= heapUsed`: Bun reports the used figure a few percent above the reserved.
    expect(now.heapTotal).toBeGreaterThan(0);
    expect(now.cpuSeconds).toBeGreaterThan(0);
    expect(Math.abs(now.uptimeSeconds - process.uptime())).toBeLessThan(1);
  });

  test('the default timer is unref-ed: it samples, and it does not hold the process open', async () => {
    stop = startProcessMetrics({ role: 'web', sampleMs: 5 });
    await Bun.sleep(30);
    const lag = collectMetrics().metrics.find(
      (one) => one.descriptor.name === 'process_event_loop_lag_seconds',
    )?.points[0] as HistogramPoint | undefined;
    expect(lag?.count ?? 0).toBeGreaterThan(0);
  });
});

/** Bundles `source` for the browser, from inside the package so the barrel resolves. */
async function browserChunk(name: string, source: string): Promise<string> {
  const entry = join(FIXTURE_DIR, `${name}.ts`);
  await Bun.write(entry, source);
  const built = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm' });
  const output = built.outputs[0];
  if (!built.success || output === undefined) {
    return expect.unreachable(`${name} did not bundle: ${built.logs.map(String).join('; ')}`);
  }
  return output.text();
}

describe('the browser path past the process series', () => {
  // Core is in every browser bundle graph (axiom 6). The barrel re-exports this module, so the
  // claim is about the ARTIFACT: a browser chunk built from the barrel names none of its series.
  test('a browser bundle importing the core barrel carries no process series', async () => {
    const page = await browserChunk(
      'page',
      "import { pageClient, UltimateError } from '@ultimat3/core';\nglobalThis.probe = [pageClient(), UltimateError];\n",
    );
    // Non-vacuity, twice: the chunk is the barrel's, and the probe string IS what a chunk that
    // reaches this module carries — the second build imports it on purpose.
    expect(page).toContain('pageClient');
    const server = await browserChunk(
      'server',
      "import { startProcessMetrics } from '@ultimat3/core';\nglobalThis.probe = startProcessMetrics;\n",
    );
    expect(server).toContain('process_resident_memory_bytes');
    expect(page).not.toContain('process_resident_memory_bytes');
    expect(page).not.toContain('process-metrics.ts');
  });
});
