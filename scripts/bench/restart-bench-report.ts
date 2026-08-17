// Percentile math and the on-disk report shape for the 50k-socket forced-restart benchmark.
// Kept separate from the orchestrator so the numbers can be unit-tested without booting a server.

import type { SeqSummary } from './restart-bench-seq';

export function percentile(sortedAsc: readonly number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const rank = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, rank)] ?? null;
}

export function summarizeDurations(valuesMs: readonly number[]) {
  const sorted = [...valuesMs].sort((a, b) => a - b);
  return {
    count: sorted.length,
    minMs: sorted[0] ?? null,
    p50Ms: percentile(sorted, 50),
    p90Ms: percentile(sorted, 90),
    p99Ms: percentile(sorted, 99),
    maxMs: sorted.at(-1) ?? null,
  };
}

export interface PhaseSummary {
  readonly requested: number;
  readonly succeeded: number;
  readonly shedAttempts: number;
  readonly durationMs: number;
  readonly reconnect: ReturnType<typeof summarizeDurations>;
  readonly consistent: ReturnType<typeof summarizeDurations>;
}

/** The on-disk shape of a run. The orchestrator annotates its report with this, so a field added
 * to one and not the other is a compile error rather than a results file nobody can parse. */
export interface BenchReport {
  readonly measuredAt: string;
  readonly clients: number;
  readonly workers: number;
  readonly acceptBudget: { readonly perSecond: number; readonly burst: number };
  readonly restartGapMs: number;
  /** How often the consistency probe published. `seq`'s resolution: a sparser probe sees less. */
  readonly probeIntervalMs: number;
  readonly ramp: PhaseSummary;
  readonly restart: PhaseSummary;
  /**
   * Delivery accounting. `ramp`/`restart` time the FIRST patch on a socket, which is reachability;
   * this is the only field that says whether anything was lost after that. A result file written
   * before 2026-08 has no `seq` key at all — that run did not measure it.
   */
  readonly seq: SeqSummary;
  readonly notes: readonly string[];
}
