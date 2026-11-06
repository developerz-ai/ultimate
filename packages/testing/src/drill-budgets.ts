// A drill's thresholds, derived from what the app declares — its request deadline, its drain and
// its readiness mode — never typed per drill. `--budget-ms` replaces the deadline alone, and the
// verdict prints that it did.

import { finiteCount, MAX_TIMER_MS } from '@ultimat3/core';
import type { DrillBudgets } from './drill-verdict';

/** The facts of an app's config a drill reads. */
export interface DrillConfig {
  /** `configureHttp({ requestTimeoutMs })`; `0` is "no deadline", which a drill cannot judge. */
  readonly requestTimeoutMs: number;
  readonly drainDeadlineMs: number;
  readonly readinessGraceMs: number;
  readonly readiness: 'dependencies' | 'process';
}

/** `@ultimat3/http`'s own default request deadline, the one a drill measures against with none set. */
export const DRILL_DEFAULT_DEADLINE_MS = 30_000;

/**
 * One bounded delay: what a degraded dependency may cost one request. The redis tier's per-command
 * deadline is 150 ms and a paused probe answered under 1 s (`29-data-redis-outage`).
 */
export const DRILL_PROMPT_MS = 1_000;

export interface DrillTiming extends DrillBudgets {
  /** How long each fault phase is held: past one deadline, so a blocked request meets it. */
  readonly phaseMs: number;
}

export function drillBudgets(config: DrillConfig, overrideMs?: number): DrillTiming {
  const declared = finiteCount('drillBudgets', 'requestTimeoutMs', config.requestTimeoutMs);
  const deadlineMs =
    overrideMs === undefined
      ? declared === 0
        ? DRILL_DEFAULT_DEADLINE_MS
        : declared
      : finiteCount('x drill', '--budget-ms', overrideMs, 1);
  const drainMs =
    finiteCount('drillBudgets', 'readinessGraceMs', config.readinessGraceMs) +
    finiteCount('drillBudgets', 'drainDeadlineMs', config.drainDeadlineMs);
  return {
    deadlineMs: Math.min(deadlineMs, MAX_TIMER_MS),
    promptMs: DRILL_PROMPT_MS,
    // Recovery and readiness are each given one deadline: a pool that replaces its sockets does
    // so on the next statement, and a statement is bounded by the request it serves.
    recoveryMs: deadlineMs,
    readinessMs: deadlineMs,
    drainMs,
    readiness: config.readiness,
    override: overrideMs,
    phaseMs: deadlineMs + DRILL_PROMPT_MS,
  };
}
