// A tenant's own view of ONE job, and its own cancel: what an app's `query` and `action` call
// (`jobStatusFor`, `cancelJobFor`). Functions, not a factory — who may read or cancel is the app's
// policy, and `jobs`/`action`/`query` share tier 3. A row of another tenant, a row queued for no
// tenant and a row that does not exist are ONE answer, `undefined`, from one fenced lookup.

import type { JobDriver, JobState } from './driver';
import { JobIntrospectionUnsupportedError } from './inspect-unsupported';
import type { JobProgress } from './introspection';
import type { JobStatusRow, TenantJobQuery, TenantJobs } from './job-status-port';

/**
 * What a tenant may see of its job. Never `input`, `lastError`, its stack, `traceparent`,
 * `enqueuedBy`, the queue or the claim: those are an operator's (`inspectJob`), and a status
 * endpoint is where a payload or a stack trace would leak to an end user.
 */
export interface JobStatus {
  readonly id: string;
  readonly name: string;
  readonly state: JobState;
  readonly attempt: number;
  readonly maxAttempts: number;
  /** What the body last reported through `progress()`; `null` until it reports. */
  readonly progress: JobProgress | null;
  readonly runAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CancelJobForInput extends TenantJobQuery {
  /** Kept as the row's `lastError` — an operator's read, never the tenant's. `''` is no reason. */
  readonly reason?: string;
}

/**
 * Lowercase canonical uuid: the shape every driver mints. Anything else names no row on any
 * driver — answered here, so Postgres never sees a malformed uuid (`22P02`) and memory and Redis
 * never answer differently from it for a cased id.
 */
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * An empty tenant or name names no row on any driver — answered here, because a script's `''` reads
 * as "any name" where SQL's `name = ''` matches nothing, and the three must give one answer.
 */
const askable = (query: TenantJobQuery): boolean =>
  JOB_ID.test(query.jobId) && query.tenantId !== '' && query.name !== '';

function fenceOf(driver: JobDriver): TenantJobs {
  if (driver.tenantJobs === undefined) {
    throw JobIntrospectionUnsupportedError.tenantJobs(driver.name);
  }
  return driver.tenantJobs;
}

const iso = (ms: number): string => new Date(ms).toISOString();

/** Field by field, so a column a driver read and this type does not name never reaches a caller. */
function toJobStatus(row: JobStatusRow): JobStatus {
  return {
    id: row.id,
    name: row.name,
    state: row.state,
    attempt: row.attempt,
    maxAttempts: row.maxAttempts,
    progress: row.progress ?? null,
    runAt: iso(row.runAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

const only = (query: TenantJobQuery): TenantJobQuery => ({
  jobId: query.jobId,
  tenantId: query.tenantId,
  ...(query.name === undefined ? {} : { name: query.name }),
});

/** The job as its tenant may see it; `undefined` for a missing row and another tenant's alike. */
export async function jobStatusFor(
  driver: JobDriver,
  query: TenantJobQuery,
): Promise<JobStatus | undefined> {
  const fence = fenceOf(driver);
  if (!askable(query)) return undefined;
  const row = await fence.status(only(query));
  return row === undefined ? undefined : toJobStatus(row);
}

/**
 * Cancel the tenant's own job when it is still live, and answer it as it now stands — `cancelled`,
 * or the finished state it had already reached (read `state`, never assume). Another tenant's job
 * is a no-op answering `undefined`, as a missing one is: never a refusal that says it exists.
 */
export async function cancelJobFor(
  driver: JobDriver,
  input: CancelJobForInput,
): Promise<JobStatus | undefined> {
  const fence = fenceOf(driver);
  if (!askable(input)) return undefined;
  // `''` is no reason: it keeps the row's `lastError` on every driver, never blanks it on one.
  const reason = input.reason === '' ? undefined : input.reason;
  const row = await fence.cancel(only(input), reason);
  return row === undefined ? undefined : toJobStatus(row);
}
