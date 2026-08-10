// Pure, driver-injected job operations behind `x jobs`: flag parsing, plus ls / show / retry. No
// CLI parsing, no process I/O, no rendering — a test drives every path with `createMemoryDriver()`
// alone. Drain is `jobs-drain.ts`, the `--json` shapes `jobs-json.ts`, the table `jobs-table.ts`.

import type {
  DeadLetterEntry,
  JobDriver,
  JobFilter,
  JobRecord,
  JobState,
  JobTrace,
  QueueDepthReport,
} from '@ultimat3/jobs';
import {
  inspectDeadLetters,
  inspectJob,
  inspectJobList,
  inspectQueues,
  retryFromStep,
} from '@ultimat3/jobs';
import { BadFlagError, JobUnknownError } from './errors';

/** Mirrors `JobState` from `@ultimat3/jobs`, which exports the type but no runtime list. */
export const JOB_STATES: readonly JobState[] = [
  'ready',
  'delayed',
  'running',
  'suspended',
  'done',
  'failed',
  'dead',
];

const isJobState = (value: string): value is JobState =>
  (JOB_STATES as readonly string[]).includes(value);

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
 */
export function parseLimitFlag(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const digits = value.trim();
  const limit = /^\d+$/.test(digits) ? Number(digits) : Number.NaN;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new BadFlagError({
      flag: 'limit',
      command: 'jobs',
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
}

export interface JobsListResult {
  readonly depth: QueueDepthReport;
  readonly rows: readonly JobRecord[];
  readonly deadLetters: readonly DeadLetterEntry[];
}

/**
 * The depth report AND the filtered rows, plus dead letters unconditionally: a dead job that a
 * `--state ready` filter (or the default 100-row cap) pushes out of view is the exact failure
 * mode this command exists to prevent.
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
  };
  const [depth, rows, deadLetters] = await Promise.all([
    inspectQueues(driver),
    inspectJobList(driver, jobFilter),
    inspectDeadLetters(driver),
  ]);
  return { depth, rows, deadLetters };
}

// ── show ──────────────────────────────────────────────────────────────────

export async function showJob(driver: JobDriver, id: string): Promise<JobTrace> {
  const trace = await inspectJob(driver, id);
  if (trace === undefined) throw new JobUnknownError({ id, driver: driver.name });
  return trace;
}

// ── retry ─────────────────────────────────────────────────────────────────

/**
 * Existence is checked up front so an unknown id always surfaces as `X_JOB_UNKNOWN`: the
 * concrete drivers (pg, memory) throw their own error from inside `requeue()` for a missing
 * row, and that error is not this command's contract — `retryFromStep`'s documented `undefined`
 * return is, and the driver never reaches it once the row is already known absent.
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
