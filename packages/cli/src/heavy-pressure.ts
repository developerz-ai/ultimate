// The CPU half of admission: a run that fits in memory still waits while the machine's CPU is
// saturated and another heavy run is going. The thresholds, their measurement and the decision live
// here; `heavy-ledger.ts` asks it only for the queue's head, so first-come order is kept.

// why: Bun ships no synchronous file read, and `/proc/pressure/cpu` is read on every poll.
import { readFileSync } from 'node:fs';
// why: Bun exposes no available-parallelism primitive.
import { availableParallelism } from 'node:os';
import { runnableTasks } from './heavy-cores';
import type { HeavyEnv } from './heavy-env';
import { HEAVY_CPU_ENV, isCi } from './heavy-env';
import { msg } from './messages';

/**
 * Measured on the 8-core shared box, 2026-11-18, `As of` Linux 7.0: four admitted runs held 14.3 of
 * 15.9 GB while load was 74-94 with 69-84 runnable tasks, and `cpu some avg10` read 95.8. Memory was
 * not the bound; CPU was, and every run on it slowed. `some` is the share of time at least one task
 * waited for a CPU: an 8-core box running one 4-core typecheck stays far below 80, and at 80 most of
 * every second already has a queue. avg10 is the shortest window the kernel keeps. ONE reading; a
 * re-measure that moves it changes only these numbers.
 */
export const CPU_SOME_BUSY_PERCENT = 80;
/** No PSI (macOS, older kernels): 69 runnable on 8 cores was 8.6 a core; 2 a core is a run queue. */
export const RUNNABLE_PER_CORE_BUSY = 2;
/**
 * How long the queue's head waits on CPU alone before it goes anyway. A holder can run for hours
 * while outside work keeps the CPU busy; this bounds the wait to one admission per window.
 */
export const CPU_WAIT_LIMIT_MS = 5 * 60_000;

export interface CpuReading {
  readonly source: 'psi' | 'runnable';
  /** `cpu some avg10` in percent, or runnable tasks per core. */
  readonly value: number;
  readonly limit: number;
  readonly busy: boolean;
}

/** `some avg10=95.83 …` → 95.83. */
export function parseCpuSome(text: string): number | undefined {
  const match = /^some avg10=(\d+(?:\.\d+)?)/m.exec(text);
  return match === null ? undefined : Number(match[1]);
}

const readPsi = (): string => readFileSync('/proc/pressure/cpu', 'utf8');

/** PSI where the kernel has it, else runnable tasks per core. Never throws. */
export function readCpuPressure(
  input: { readonly read?: () => string; readonly cores?: number; readonly runnable?: number } = {},
): CpuReading {
  let some: number | undefined;
  try {
    some = parseCpuSome((input.read ?? readPsi)());
  } catch {
    some = undefined; // No PSI here.
  }
  if (some !== undefined) {
    return {
      source: 'psi',
      value: some,
      limit: CPU_SOME_BUSY_PERCENT,
      busy: some >= CPU_SOME_BUSY_PERCENT,
    };
  }
  const cores = Math.max(1, input.cores ?? availableParallelism());
  const perCore = Math.round(((input.runnable ?? runnableTasks()) / cores) * 10) / 10;
  return {
    source: 'runnable',
    value: perCore,
    limit: RUNNABLE_PER_CORE_BUSY,
    busy: perCore >= RUNNABLE_PER_CORE_BUSY,
  };
}

/**
 * Whether the head may start on CPU grounds. Never `wait` with nothing admitted: pressure from work
 * outside the ledger must not stop the only run, and a ledger with no holder cannot deadlock.
 */
export function cpuAdmission(input: {
  readonly reading: CpuReading | undefined;
  /** Reservations admitted now. */
  readonly running: number;
  /** How long the head has waited on CPU alone. */
  readonly blockedMs: number;
}): 'admit' | 'wait' {
  if (input.reading?.busy !== true || input.running === 0) return 'admit';
  return input.blockedMs >= CPU_WAIT_LIMIT_MS ? 'admit' : 'wait';
}

/**
 * Off in CI (single-tenant), off inside a test run (a fixture must not wait on the machine it runs
 * on; `ambient` is this process's own env), and off with `ULTIMATE_HEAVY_CPU=0`.
 */
export function cpuGateOn(env: HeavyEnv, ambient: HeavyEnv = Bun.env): boolean {
  if (isCi(env) || env[HEAVY_CPU_ENV] === '0') return false;
  return env['NODE_ENV'] !== 'test' && ambient['NODE_ENV'] !== 'test';
}

/** `CPU pressure 96% (new runs wait at 80%)`. */
export const cpuText = (reading: CpuReading): string =>
  msg(reading.source === 'psi' ? 'cli.heavy.cpu.psi' : 'cli.heavy.cpu.runnable', {
    value: reading.source === 'psi' ? Math.round(reading.value) : reading.value,
    limit: reading.limit,
  });
