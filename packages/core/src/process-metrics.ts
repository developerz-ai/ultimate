// Single responsibility: the series every Ultimate PROCESS emits about itself — memory, CPU,
// event-loop lag, start time and which role it is. `runtime-metrics.ts` names what a role does;
// this names what the process costs, so "what is growing?" is a query and not a guess. Runs
// nothing at import: the first `startProcessMetrics()` declares the instruments.

import { type Clock, systemClock } from './clock';
import { finiteCount } from './finite-option';
import type { Counter, Gauge, Histogram } from './metrics';
import { counter, gauge, histogram } from './metrics';

/**
 * One reading of the process, in bytes and seconds — everything `process` answers in microseconds.
 * No object count and no collection count: `bun:jsc`'s `heapStats()` runs a full collection to
 * answer (9 ms on an empty framework process, measured 2026-10-01), which a scrape must not cause.
 */
export interface ProcessReading {
  /** Resident set size: what the kernel charges the container for. */
  readonly rss: number;
  /** Bytes of JavaScript heap in use, garbage not yet collected included. */
  readonly heapUsed: number;
  /** Bytes the engine has reserved for the heap, used or not. */
  readonly heapTotal: number;
  /** Bytes held outside the heap on behalf of heap objects: buffers, strings, compiled code. */
  readonly external: number;
  /** User plus system CPU seconds consumed since the process started. */
  readonly cpuSeconds: number;
  /** Seconds since the process started — what places `process_start_time_seconds`. */
  readonly uptimeSeconds: number;
}

/**
 * How often the event loop is asked how late it is, and the only work this module does unasked.
 * One timer wake a second: measured at 0.12 millicore on top of the 1.8 an idle Bun process
 * already spends (20 s of `process.cpuUsage()`, sampler on against off, 2026-10-01).
 */
export const EVENT_LOOP_SAMPLE_MS = 1000;

/** A stalled loop is the signal, so the buckets run from a millisecond to a frozen process. */
export const EVENT_LOOP_LAG_BOUNDS: readonly number[] = Object.freeze([
  0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 10,
]);

/** The default reading: `process.memoryUsage()` and `process.cpuUsage()`, ~12 µs together. */
export function readProcess(): ProcessReading {
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  return {
    rss: memory.rss,
    heapUsed: memory.heapUsed,
    heapTotal: memory.heapTotal,
    external: memory.external,
    cpuSeconds: (cpu.user + cpu.system) / 1_000_000,
    uptimeSeconds: process.uptime(),
  };
}

export interface ProcessMetricsOptions {
  /** What this process is: a `ROLE`, or `x dev`'s several joined. The `process_info` label. */
  readonly role: string;
  /** Defaults to `readProcess`. Injected by a test. */
  readonly read?: (() => ProcessReading) | undefined;
  readonly clock?: Clock | undefined;
  /** The sampler's timer. Injected by a test; the default is an unref'd `setInterval`. */
  readonly every?: ((tick: () => void, intervalMs: number) => () => void) | undefined;
  readonly sampleMs?: number | undefined;
}

interface Instruments {
  readonly cpu: Counter;
  readonly lag: Histogram;
  readonly info: Gauge;
}

// The live source. The observers below are declared ONCE and read through it, because a gauge
// redeclared with a different `observe` is refused (`X_METRIC_NAME_INVALID`) and a process may
// start, stop and start this again — every `x dev` reload does.
let source: (() => ProcessReading) | undefined;
let startedAtSeconds = 0;
let instruments: Instruments | undefined;
// What the counter already holds, kept across a stop and a start so neither loses the CPU spent
// before the first sample — a boot is where most of it goes — nor counts it twice.
let cpuCounted = 0;

/** 0 while stopped: a scrape between a stop and a start reads a flat line, never a throw. */
const observed = (pick: (reading: ProcessReading) => number) => (): number =>
  source === undefined ? 0 : pick(source());

function declare(): Instruments {
  if (instruments !== undefined) return instruments;
  gauge('process_resident_memory_bytes', {
    unit: 'By',
    description: 'Resident set size of this process',
    observe: observed((reading) => reading.rss),
  });
  gauge('process_heap_used_bytes', {
    unit: 'By',
    description: 'JavaScript heap in use, garbage not yet collected included',
    observe: observed((reading) => reading.heapUsed),
  });
  gauge('process_heap_total_bytes', {
    unit: 'By',
    description: 'JavaScript heap reserved by the engine',
    observe: observed((reading) => reading.heapTotal),
  });
  gauge('process_external_memory_bytes', {
    unit: 'By',
    description: 'Memory held outside the heap for heap objects: buffers, strings, compiled code',
    observe: observed((reading) => reading.external),
  });
  gauge('process_start_time_seconds', {
    unit: 's',
    description: 'When this process started, in seconds since the Unix epoch',
    observe: () => startedAtSeconds,
  });
  instruments = {
    cpu: counter('process_cpu_seconds_total', {
      unit: 's',
      description: 'User and system CPU time consumed by this process',
    }),
    lag: histogram('process_event_loop_lag_seconds', {
      unit: 's',
      description: `How late the event loop ran a ${String(EVENT_LOOP_SAMPLE_MS)}ms timer, sampled once per interval`,
      bounds: EVENT_LOOP_LAG_BOUNDS,
    }),
    info: gauge('process_info', {
      unit: '1',
      description: 'Always 1; the labels say which role this process runs',
    }),
  };
  return instruments;
}

const unrefInterval = (tick: () => void, intervalMs: number): (() => void) => {
  const timer = setInterval(tick, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
};

/** Test-only: forget the CPU already counted, beside `resetMetrics()` dropping the counter. */
export function resetProcessMetrics(): void {
  source = undefined;
  cpuCounted = 0;
}

/**
 * Starts the process series and the one sampler behind two of them, and answers the stop. Called
 * by whatever opens the scrape listener, so every role that can be scraped reports itself.
 *
 * CPU is a COUNTER fed by the sampler rather than a gauge read at scrape time: `rate()` over a
 * counter survives a restart, and an observed gauge named `_total` would lie about its type.
 */
export function startProcessMetrics(options: ProcessMetricsOptions): () => void {
  const clock = options.clock ?? systemClock;
  const read = options.read ?? readProcess;
  const sampleMs = finiteCount(
    'startProcessMetrics',
    'sampleMs',
    options.sampleMs ?? EVENT_LOOP_SAMPLE_MS,
    1,
  );
  const declared = declare();
  source = read;
  // Uptime subtracted from now: the process started before this module was asked.
  startedAtSeconds = Math.floor(clock.now().getTime() / 1000 - read().uptimeSeconds);
  declared.info.record(1, { role: options.role });

  const countCpu = (): void => {
    const cpu = read().cpuSeconds;
    // Monotonic by construction, and guarded anyway: a counter refuses a negative delta.
    if (cpu > cpuCounted) declared.cpu.add(cpu - cpuCounted);
    cpuCounted = Math.max(cpu, cpuCounted);
  };
  countCpu();
  let due = clock.monotonic() + sampleMs;
  const stopTimer = (options.every ?? unrefInterval)(() => {
    const now = clock.monotonic();
    // Late by this much; a timer that fires early reports no lag rather than a negative one.
    declared.lag.record(Math.max(0, now - due) / 1000);
    due = now + sampleMs;
    countCpu();
  }, sampleMs);

  return () => {
    stopTimer();
    if (source === read) source = undefined;
  };
}
