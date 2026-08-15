// `x db backfill`, everything except the argv: the ledger `--list` reports, the declared-minus-
// completed diff `--pending` reports, and the gate-plus-enqueue `<name>`/`--all` performs. A
// driver plus plain strings in, plain data out — the `cmd-jobs.ts` / `jobs-report.ts` split
// repeated, so every projection here is testable with no `ParsedArgs`, no app boot and no queue.
// `cmd-db.ts` is the CLI wiring and nothing else.
//
// The decisions themselves are `@ultimat3/jobs`': `gateBackfill`, `pendingBackfills` and
// `registeredBackfills` all live there, because the pass enforces the same rails and two copies of
// "may this sweep run" would be two answers. What is decided HERE is only what the CLI knows —
// which names were asked for, whether `--write` was passed, and what `x_migrations` says.

import type { Environment } from '@ultimat3/core';
import { createContext } from '@ultimat3/core';
import { db, isLedgerMissing, readLedger } from '@ultimat3/db';
import type {
  BackfillDeclaration,
  BackfillInput,
  BackfillPendingReport,
  BackfillProgress,
  BackfillState,
  BackfillStatus,
  JobDriver,
  JobHandle,
} from '@ultimat3/jobs';
import {
  BACKFILL_STATUSES,
  BackfillRunningError,
  BackfillUnknownError,
  backfillOrigin,
  gateBackfill,
  getBackfill,
  inspectBackfills,
  isBackfillStatus,
  isPendingBackfillState,
  pendingBackfills,
  registeredBackfills,
} from '@ultimat3/jobs';
import { BadFlagError } from './errors';
import { parseLimitFlag } from './jobs-report';
import { msg } from './messages';
import type { Finding, JsonValue } from './output';
import { findingFrom } from './output';
import { renderTable } from './table';

/**
 * The list and the guard are `@ultimat3/jobs`': a status the ledger can record and this flag
 * rejects is exactly the drift a second copy here would produce.
 */
export function parseBackfillStatusFlag(value: string | undefined): BackfillStatus | undefined {
  if (value === undefined) return undefined;
  if (isBackfillStatus(value)) return value;
  throw new BadFlagError({
    flag: 'status',
    command: 'db',
    reason: `unknown status "${value}" (known: ${BACKFILL_STATUSES.join(', ')})`,
    fix: 'x db backfill --list --json',
  });
}

export interface BackfillListFilter {
  readonly name?: string | undefined;
  readonly status?: string | undefined;
  readonly limit?: string | undefined;
}

/**
 * Every pass the ledger holds, newest first, filtered by the flags as typed. The empty list is an
 * ANSWER — a driver with no ledger and an app that has never swept anything are both "nothing has
 * run", and `inspectBackfills` already refuses to throw for either.
 */
export async function listBackfills(
  driver: JobDriver,
  filter: BackfillListFilter = {},
): Promise<readonly BackfillProgress[]> {
  const status = parseBackfillStatusFlag(filter.status);
  const limit = parseLimitFlag(filter.limit, 'db');
  return inspectBackfills(driver, {
    ...(filter.name === undefined ? {} : { name: filter.name }),
    ...(status === undefined ? {} : { status }),
    ...(limit === undefined ? {} : { limit }),
  });
}

const HEADER = ['name', 'status', 'rows', 'cursor', 'started-at', 'duration-ms', 'run-id'] as const;

/**
 * `started-at` is the ledger's own ISO string, printed verbatim and never re-formatted: the repo
 * forbids a date rendered without an explicit IANA `timeZone`, and not formatting at all is the
 * one rendering with no zone to get wrong — the same rule `jobs-table.ts` states for `run-at-ms`.
 * `--json` carries these exact values, so the two renders of one command stay comparable.
 */
export function renderBackfillTable(rows: readonly BackfillProgress[]): readonly string[] {
  const none = msg('cli.db.backfill.none');
  return renderTable(
    HEADER,
    rows.map((row) => [
      row.name,
      row.status,
      String(row.rows),
      row.cursor ?? none,
      row.startedAt,
      row.durationMs === null ? none : String(row.durationMs),
      row.runId,
    ]),
  );
}

// ── declared minus completed ──────────────────────────────────────────────

/**
 * Every declaration this app made, judged against every pass the ledger holds. The ledger read is
 * `inspectBackfills` and never a second one, and the arithmetic is `@ultimat3/jobs`' — this
 * function is the join and nothing else.
 */
export async function pendingReport(
  driver: JobDriver,
  environment: Environment,
): Promise<BackfillPendingReport> {
  return pendingBackfills({
    declarations: registeredBackfills(),
    // Unfiltered and unlimited: a name whose only pass scrolled past a `--limit` would be reported
    // as never run, which is the one answer this diff must never get wrong.
    runs: await inspectBackfills(driver, { limit: Number.MAX_SAFE_INTEGER }),
    environment,
  });
}

const PENDING_HEADER = ['name', 'state', 'requires', 'environments', 'last-run-id'] as const;

export function renderPendingTable(report: BackfillPendingReport): readonly string[] {
  const none = msg('cli.db.backfill.none');
  return renderTable(
    PENDING_HEADER,
    report.rows.map((row) => [
      row.name,
      row.state,
      row.requires ?? none,
      row.environments === null ? none : row.environments.join('|'),
      row.lastRunId ?? none,
    ]),
  );
}

export function pendingToJson(report: BackfillPendingReport): JsonValue {
  return {
    environment: report.environment,
    declared: report.rows.length,
    pending: report.pending.map((row) => row.name),
    orphaned: [...report.orphaned],
    rows: report.rows.map((row) => ({
      name: row.name,
      state: row.state,
      checksum: row.checksum,
      ledgerChecksum: row.ledgerChecksum,
      changed: row.changed,
      requires: row.requires,
      environments: row.environments === null ? null : [...row.environments],
      lastRunId: row.lastRunId,
      rows: row.rows,
    })),
  };
}

// ── running one ───────────────────────────────────────────────────────────

/**
 * Migration ids `x_migrations` records as applied. Three outcomes, and they mean different things:
 *
 * | Answer | When | Gate reads it as |
 * |---|---|---|
 * | the ids | the ledger was read | exactly what is applied |
 * | `[]` | `x_migrations` does not exist | nothing applied — every `requires` is unsatisfied |
 * | `undefined` | no declaration waits on a migration | there is nothing to check |
 *
 * An absent table is an ANSWER, never a failure: a database this app has never migrated genuinely
 * has no applied migration, so `[]` blocks and that is the honest verdict. Everything else —
 * permission denied, a timeout, a dropped connection, a malformed query — means the check DID NOT
 * HAPPEN, and those propagate. A gate that read "I could not ask" as "it is applied" would let a
 * sweep run against exactly the shape it exists to wait for, which is the silent pass this whole
 * slice exists to remove.
 *
 * The read is skipped entirely when nothing declares `requires`: it opens the app's database, and
 * a command with no question to ask must not fail for want of an answer it will not use.
 */
export async function readAppliedMigrations(): Promise<readonly string[] | undefined> {
  if (!registeredBackfills().some((declaration) => declaration.requires !== null)) return undefined;
  try {
    return (await readLedger(db())).map((row) => row.id);
  } catch (error) {
    if (isLedgerMissing(error)) return [];
    throw error;
  }
}

/** What one name's turn produced. `planned` is the dry run — `--write` is never implied. */
export type BackfillAction = 'planned' | 'enqueued' | 'deduped' | 'blocked';

export interface BackfillPlanRow {
  readonly name: string;
  readonly action: BackfillAction;
  readonly state: BackfillState | null;
  /** The queue row a `--write` created. `null` for every dry run and every refusal. */
  readonly jobId: string | null;
  /** What `count()` still matches, when the declaration has one and it could be asked. */
  readonly remaining: number | null;
  readonly finding: Finding | null;
}

/**
 * `count()` is the same predicate `source` selects on, so this is the one number that keeps a dry
 * run honest. A tenanted sweep counts within one org — its `ctx.actor` carries none here — so a
 * throw is reported as `null` rather than guessed at: a dry run that invented a row count is the
 * failure `count()` exists to close.
 */
async function remainingFor(declaration: BackfillDeclaration): Promise<number | null> {
  if (!declaration.counts) return null;
  const handle = getBackfill(declaration.name);
  const count = handle === undefined ? undefined : backfillOrigin(handle)?.count;
  if (count === undefined) return null;
  try {
    return await count({ ctx: createContext({ role: 'migrate' }) });
  } catch {
    return null;
  }
}

/**
 * One shape for `X_BACKFILL_UNKNOWN`, wherever it is raised. Two constructions of one code with
 * different payloads — one listing the candidate names and one listing none — is a finding an
 * agent cannot act on half the time, which is the same code meaning two things.
 */
const unknownRow = (
  name: string,
  state: BackfillState | null,
  declarations: readonly BackfillDeclaration[],
): BackfillPlanRow => ({
  name,
  action: 'blocked',
  state,
  jobId: null,
  remaining: null,
  finding: findingFrom(
    new BackfillUnknownError({ backfill: name, known: declarations.map((row) => row.name) }),
  ),
});

export interface BackfillRunInput {
  readonly driver: JobDriver;
  /** The names asked for, or every PENDING one when `--all` was passed. */
  readonly names: readonly string[] | 'all';
  readonly write: boolean;
  readonly force: boolean;
  readonly environment: Environment;
  readonly appliedMigrations: readonly string[] | undefined;
}

/**
 * One turn per name, isolated: a refusal or a throw becomes that name's row and the loop goes on.
 * That isolation is the whole point of `--all` — one wedged cleanup must not block every later one
 * forever, which is exactly what a `for` loop over a throwing gate would have done.
 */
export async function runBackfills(input: BackfillRunInput): Promise<readonly BackfillPlanRow[]> {
  const report = await pendingReport(input.driver, input.environment);
  const declarations = registeredBackfills();
  const byName = new Map(declarations.map((row) => [row.name, row]));
  // `--all` sweeps what is PENDING, and `--all --force` every name this environment may run: a
  // forced rerun of a completed name is a decision, so it is never what a bare `--all` performs.
  //
  // Selected by STATE through `@ultimat3/jobs`' own predicate, never by `report.pending.includes`:
  // that worked only because `pendingBackfills` filters the same array it returns, and the day it
  // mapped its rows instead, `--all` would have found zero targets, exited 0 and reported that
  // nothing needed sweeping — the silent success this slice exists to remove, reintroduced by an
  // identity check nobody could see from here.
  const targets =
    input.names === 'all'
      ? report.rows
          .filter((row) =>
            input.force ? row.state !== 'excluded' : isPendingBackfillState(row.state),
          )
          .map((row) => row.name)
      : input.names;

  const rows: BackfillPlanRow[] = [];
  for (const name of targets) {
    const declaration = byName.get(name);
    const state = report.rows.find((row) => row.name === name)?.state ?? null;
    if (declaration === undefined) {
      rows.push(unknownRow(name, state, declarations));
      continue;
    }
    const verdict = gateBackfill({
      declaration,
      environment: input.environment,
      appliedMigrations: input.appliedMigrations,
      // Only fetched for a name the diff already judged completed — the gate wants the row, and
      // the diff is what knows whether there is one to want.
      completed: state === 'completed' ? await newestCompleted(input.driver, name) : undefined,
      force: input.force,
    });
    if (!verdict.run) {
      rows.push({
        name,
        action: 'blocked',
        state,
        jobId: null,
        remaining: null,
        finding: findingFrom(verdict.error),
      });
      continue;
    }
    const remaining = await remainingFor(declaration);
    if (!input.write) {
      rows.push({ name, action: 'planned', state, jobId: null, remaining, finding: null });
      continue;
    }
    // `getBackfill` cannot answer undefined here — `declaration` came from `registeredBackfills()`,
    // which is derived from the same registry — so the handle is resolved once, at the only place
    // that already proved the name exists. Resolving it again inside `enqueueOne` meant a second
    // `X_BACKFILL_UNKNOWN` that could not list the candidates the first one lists.
    const handle = getBackfill(name);
    if (handle === undefined) {
      rows.push(unknownRow(name, state, declarations));
      continue;
    }
    rows.push(await enqueueOne(handle, state, remaining, input.force));
  }
  return rows;
}

const newestCompleted = async (
  driver: JobDriver,
  name: string,
): Promise<BackfillProgress | undefined> =>
  (await inspectBackfills(driver, { name, status: 'completed', limit: 1 }))[0];

/**
 * The queue is a job's execution surface, so `--write` ENQUEUES and never runs the pass inline —
 * the rule `handle.as()` already states. That is also what makes `ROLE=backfill` a trigger rather
 * than a gate: the container puts the sweeps on the queue and exits, and the workers already
 * serving the new release are what drain them.
 */
async function enqueueOne(
  handle: JobHandle<BackfillInput>,
  state: BackfillState | null,
  remaining: number | null,
  force: boolean,
): Promise<BackfillPlanRow> {
  const name = handle.name;
  try {
    const result = await handle.enqueue({ force });
    // One live pass per name, forced or not. A deduped enqueue started nothing, so the operator who
    // asked for a pass has to hear about the one already holding the key.
    return result.deduped
      ? {
          name,
          action: 'deduped',
          state,
          jobId: result.id,
          remaining,
          finding: findingFrom(new BackfillRunningError({ backfill: name, jobId: result.id })),
        }
      : { name, action: 'enqueued', state, jobId: result.id, remaining, finding: null };
  } catch (error) {
    return { name, action: 'blocked', state, jobId: null, remaining, finding: findingFrom(error) };
  }
}

const PLAN_HEADER = ['name', 'action', 'state', 'remaining', 'job-id'] as const;

export function renderPlanTable(rows: readonly BackfillPlanRow[]): readonly string[] {
  const none = msg('cli.db.backfill.none');
  return renderTable(
    PLAN_HEADER,
    rows.map((row) => [
      row.name,
      row.action,
      row.state ?? none,
      row.remaining === null ? none : String(row.remaining),
      row.jobId ?? none,
    ]),
  );
}

export function planToJson(rows: readonly BackfillPlanRow[]): JsonValue {
  return rows.map((row) => ({
    name: row.name,
    action: row.action,
    state: row.state,
    remaining: row.remaining,
    jobId: row.jobId,
    finding:
      row.finding === null
        ? null
        : {
            code: row.finding.code,
            cause: row.finding.cause,
            fix: row.finding.fix,
            docs: row.finding.docs ?? null,
          },
  }));
}
