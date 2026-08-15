// Declared minus completed — the diff nothing in the framework could compute, because until
// `backfill-registry.ts` only half of it existed. `inspectBackfills` reads the ledger, so a sweep
// that was merged and never enqueued had no row and appeared on no surface at all.
//
// Pure: declarations in, ledger rows in, verdict out. The reader is `x db backfill --pending`,
// whose non-zero exit is what lets a cron or a deploy check answer "is anything unswept" without
// parsing a table.

import type { Environment } from '@ultimat3/core';
import { checkBackfillEnvironment } from './backfill-gate';
// `BackfillProgress` and not the driver's own `BackfillRun`: `inspectBackfills()` is the ONE
// projection of the ledger, and this diff is its fifth reader rather than a sixth path into rows.
import type { BackfillProgress } from './backfill-inspect';
import type { BackfillDeclaration } from './backfill-registry';

/**
 * `excluded` is a declaration this environment may not run at all, and it is the reason the diff
 * needs an environment: a production-only cleanup read in staging is not drift, and an alarm that
 * fired on it would be muted within a week.
 */
export const BACKFILL_STATES = ['pending', 'running', 'failed', 'completed', 'excluded'] as const;

export type BackfillState = (typeof BACKFILL_STATES)[number];

/** One declaration, judged against the ledger. Plain JSON: absent is `null`, never `undefined`. */
export interface BackfillStateRow {
  readonly name: string;
  readonly state: BackfillState;
  readonly checksum: string;
  /** The checksum the newest run under this name recorded, when there is one. */
  readonly ledgerChecksum: string | null;
  /** The completed pass ran under a different definition. Reported, never a refusal. */
  readonly changed: boolean;
  readonly requires: string | null;
  readonly environments: readonly Environment[] | null;
  readonly lastRunId: string | null;
  readonly rows: number | null;
}

export interface BackfillPendingReport {
  readonly environment: Environment;
  /** Every declaration, judged. Newest-first ledger rows decide each verdict. */
  readonly rows: readonly BackfillStateRow[];
  /**
   * The alarm: `pending` and `failed`, never `running` — a pass in flight is progress, and a check
   * that went red for the duration of every sweep is a check nobody leaves wired to a deploy.
   */
  readonly pending: readonly BackfillStateRow[];
  /** Ledger names no declaration carries — a sweep whose module was deleted after it ran. */
  readonly orphaned: readonly string[];
}

/**
 * The states the alarm is about, declared ONCE. `x db backfill --all` picks its targets by this
 * same predicate, and a second literal there would be a second definition of "pending" — one of
 * which would eventually be wrong while the other stayed right.
 */
export const PENDING_BACKFILL_STATES: readonly BackfillState[] = ['pending', 'failed'];

export const isPendingBackfillState = (state: BackfillState): boolean =>
  PENDING_BACKFILL_STATES.includes(state);

/**
 * Newest first is `BackfillLedger.list`'s contract, so within a name the first row is the newest.
 * Grouped ONCE rather than filtered per declaration: `x db backfill --pending` reads the ledger
 * with no limit, so a per-declaration scan is three passes over an unbounded list for every sweep
 * the app declares.
 */
function groupByName(
  runs: readonly BackfillProgress[],
): ReadonlyMap<string, readonly BackfillProgress[]> {
  const byName = new Map<string, BackfillProgress[]>();
  for (const run of runs) {
    const under = byName.get(run.name);
    if (under === undefined) byName.set(run.name, [run]);
    else under.push(run);
  }
  return byName;
}

function stateOf(
  declaration: BackfillDeclaration,
  under: readonly BackfillProgress[],
  completed: BackfillProgress | undefined,
  environment: Environment,
): BackfillState {
  if (
    checkBackfillEnvironment(declaration.name, declaration.environments, environment) !== undefined
  ) {
    return 'excluded';
  }
  // A completed row anywhere in this name's history is what blocks a re-run, so it decides the
  // state even when a later forced pass failed — `decideBackfill` reads the same fact.
  if (completed !== undefined) return 'completed';
  const newest = under[0];
  if (newest === undefined) return 'pending';
  return newest.status === 'running' ? 'running' : 'failed';
}

export function pendingBackfills(input: {
  readonly declarations: readonly BackfillDeclaration[];
  /** Every `x_backfills` row, newest first — `inspectBackfills`' own order, unfiltered. */
  readonly runs: readonly BackfillProgress[];
  readonly environment: Environment;
}): BackfillPendingReport {
  const byName = groupByName(input.runs);
  const rows = input.declarations.map((declaration): BackfillStateRow => {
    const under = byName.get(declaration.name) ?? [];
    const newest = under[0];
    const completed = under.find((run) => run.status === 'completed');
    return {
      name: declaration.name,
      state: stateOf(declaration, under, completed, input.environment),
      checksum: declaration.checksum,
      ledgerChecksum: newest?.checksum ?? null,
      changed: completed !== undefined && completed.checksum !== declaration.checksum,
      requires: declaration.requires,
      environments: declaration.environments,
      lastRunId: newest?.runId ?? null,
      rows: newest?.rows ?? null,
    };
  });
  const declared = new Set(input.declarations.map((declaration) => declaration.name));
  const orphaned = [...byName.keys()].filter((name) => !declared.has(name)).sort();
  return {
    environment: input.environment,
    rows,
    pending: rows.filter((row) => isPendingBackfillState(row.state)),
    orphaned,
  };
}
