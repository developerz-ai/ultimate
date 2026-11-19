// When a crashed child comes back, and when the supervisor stops trying. Pure: the loop in
// `supervise.ts` hands in the clock's reading and the child's uptime, and keeps what comes back.

import { DRAIN_TIMEOUT_EXIT_CODE } from '@ultimat3/core';

/** The first restart waits a second, then 2, 4, 8… */
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_CAP_MS = 30_000;
/** A child up this long before it crashed was healthy: its backoff starts over. */
export const STABLE_UPTIME_MS = 60_000;
/** This many unexpected exits of one child inside the window is a crash loop. */
export const CRASH_LIMIT = 5;
export const CRASH_WINDOW_MS = 5 * 60_000;

export interface CrashHistory {
  /** Crashes since the child last stayed up `STABLE_UPTIME_MS`. */
  readonly consecutive: number;
  /** When each crash inside the window happened, oldest first. */
  readonly at: readonly number[];
}

export const NO_CRASHES: CrashHistory = { consecutive: 0, at: [] };

export interface RestartDecision {
  readonly history: CrashHistory;
  readonly delayMs: number;
  /** `CRASH_LIMIT` inside `CRASH_WINDOW_MS`: drain the siblings and exit 1. */
  readonly loop: boolean;
}

export function afterCrash(history: CrashHistory, now: number, uptimeMs: number): RestartDecision {
  const consecutive = (uptimeMs >= STABLE_UPTIME_MS ? 0 : history.consecutive) + 1;
  const at = [...history.at.filter((when) => now - when < CRASH_WINDOW_MS), now];
  return {
    history: { consecutive, at },
    delayMs: Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (consecutive - 1)),
    loop: at.length >= CRASH_LIMIT,
  };
}

/** Exit codes, aggregated over the children of one stop: core's 70 wins, then any failure. */
export function aggregateExit(codes: readonly (number | null)[], killedAtCeiling: boolean): number {
  if (killedAtCeiling || codes.includes(DRAIN_TIMEOUT_EXIT_CODE)) return DRAIN_TIMEOUT_EXIT_CODE;
  return codes.every((code) => code === 0) ? 0 : 1;
}
