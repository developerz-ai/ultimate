// Pure, driver-injected job operations behind `x jobs`: flag parsing, plus list / show / retry. No
// CLI parsing, no process I/O, no rendering — a test drives every path with `memoryJobDriver()`
// alone. The `--json` shapes are `jobs-json.ts`, the table `jobs-table.ts`.

import type { Page } from '@ultimat3/core';
import { pageOf } from '@ultimat3/core';
import type {
  BackfillProgress,
  DeadLetterEntry,
  JobDriver,
  JobFilter,
  JobRecord,
  JobState,
  JobTrace,
  QueueDepthReport,
} from '@ultimat3/jobs';
import {
  DEFAULT_JOB_PAGE,
  inspectBackfills,
  inspectDeadLetters,
  inspectJob,
  inspectJobList,
  inspectQueues,
  isJobState,
  JOB_STATES,
  jobCursor,
  MAX_JOB_PAGE,
  retryFromStep,
} from '@ultimat3/jobs';
import { BadFlagError, JobUnknownError } from './errors';

export function parseStateFlag(value: string | undefined): JobState | undefined {
  if (value === undefined) return undefined;
  if (isJobState(value)) return value;
  throw new BadFlagError({
    flag: 'state',
    command: 'jobs',
    reason: `unknown state "${value}" (known: ${JOB_STATES.join(', ')})`,
  });
}

/**
 * A digit string is not yet a limit: past `Number.MAX_SAFE_INTEGER` the parse silently lands on a
 * different integer, and `1e400`-shaped input yields `Infinity`. Either way the driver would be
 * handed a bound other than the one typed, so the safe-integer check is the flag's real contract.
 *
 * `command` exists because `x db backfill --list` takes the same `--limit` and must not report it
 * as a flag on `x jobs` — one parser, and the error still names the command that was typed.
 */
export function parseLimitFlag(value: string | undefined, command = 'jobs'): number | undefined {
  if (value === undefined) return undefined;
  const digits = value.trim();
  const limit = /^\d+$/.test(digits) ? Number(digits) : Number.NaN;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new BadFlagError({
      flag: 'limit',
      command,
      reason: `expects an integer from 1 to ${Number.MAX_SAFE_INTEGER}, got "${value}"`,
    });
  }
  return limit;
}

// ── ls ────────────────────────────────────────────────────────────────────

export interface JobsListFilter {
  readonly queue?: string | undefined;
  readonly state?: string | undefined;
  readonly name?: string | undefined;
  readonly limit?: string | undefined;
  /** `jobCursor(lastRow)` of the page before — the keyset the next page seeks from. */
  readonly after?: string | undefined;
}

/** ONE page of rows — core's `Page`, so `nextCursor` exists exactly when another row does. */
export type JobsListResult = Page<JobRecord> & {
  readonly depth: QueueDepthReport;
  readonly deadLetters: readonly DeadLetterEntry[];
  /** The sweeps still in flight — see below for why finished ones are not this command's answer. */
  readonly backfills: readonly BackfillProgress[];
};

/**
 * One page, and whether a row exists past it — asked of the queue, never guessed from a count.
 * `next = rows.length === limit ? cursor : null` handed a FULL last page a cursor to an empty one.
 * The page reads one row past its limit; at `MAX_JOB_PAGE` there is no room for that row (the
 * queue refuses a bigger page), so a full maximal page asks for the one row after its last.
 */
async function jobPage(driver: JobDriver, filter: JobFilter): Promise<Page<JobRecord>> {
  const size = filter.limit ?? DEFAULT_JOB_PAGE;
  const ask = size < MAX_JOB_PAGE ? size + 1 : size;
  const fetched = await inspectJobList(driver, { ...filter, limit: ask });
  const rows = fetched.slice(0, size);
  const last = rows.at(-1);
  if (last === undefined || fetched.length < size) return pageOf(rows, null);
  if (fetched.length > size) return pageOf(rows, jobCursor(last));
  if (ask > size) return pageOf(rows, null);
  const after = jobCursor(last);
  const beyond = await inspectJobList(driver, { ...filter, limit: 1, after });
  return pageOf(rows, beyond.length > 0 ? after : null);
}

/**
 * The depth report AND the filtered rows, plus dead letters unconditionally: a dead job that a
 * `--state ready` filter (or the default 100-row cap) pushes out of view is the exact failure
 * mode this command exists to prevent.
 *
 * Backfills are read `running` only. `x jobs list` is a LIVE view of the queue — a pass that
 * finished last week is history, and `x db backfill --list` is where that question is asked and
 * answered with the whole ledger. A driver with no ledger answers `[]` rather than throwing, so
 * the queue view never fails over a fact nobody asked about.
 */
export async function listJobs(
  driver: JobDriver,
  filter: JobsListFilter = {},
): Promise<JobsListResult> {
  const state = parseStateFlag(filter.state);
  const limit = parseLimitFlag(filter.limit);
  const jobFilter: JobFilter = {
    ...(filter.queue === undefined ? {} : { queue: filter.queue }),
    ...(filter.name === undefined ? {} : { name: filter.name }),
    ...(state === undefined ? {} : { state }),
    ...(limit === undefined ? {} : { limit }),
    ...(filter.after === undefined ? {} : { after: filter.after }),
  };
  const [depth, page, deadLetters, backfills] = await Promise.all([
    inspectQueues(driver),
    jobPage(driver, jobFilter),
    inspectDeadLetters(driver),
    inspectBackfills(driver, { status: 'running' }),
  ]);
  return { ...page, depth, deadLetters, backfills };
}

// ── show ──────────────────────────────────────────────────────────────────

export async function showJob(driver: JobDriver, id: string): Promise<JobTrace> {
  const trace = await inspectJob(driver, id);
  if (trace === undefined) throw new JobUnknownError({ id, driver: driver.name });
  return trace;
}

// ── retry ─────────────────────────────────────────────────────────────────

/**
 * Existence is checked up front so an unknown id always surfaces as `X_JOB_UNKNOWN`: both
 * drivers answer `X_JOB_NOT_FOUND` from inside `requeue()` for a missing row, and that code is
 * the driver's contract, not this command's — `retryFromStep`'s documented `undefined` return
 * is, and the driver never reaches it once the row is already known absent.
 */
export async function retryJob(
  driver: JobDriver,
  id: string,
  fromStep?: string,
): Promise<JobTrace> {
  const existing = await inspectJob(driver, id);
  if (existing === undefined) throw new JobUnknownError({ id, driver: driver.name });
  const trace = await retryFromStep(driver, id, fromStep);
  if (trace === undefined) throw new JobUnknownError({ id, driver: driver.name });
  return trace;
}
