// The job rows as an `AdminRepo`: a page is ONE `JobIntrospection.list` call, newest first and
// keyset by `(createdAt, id)` — the store's own order, and the only one it answers — and a detail
// is the store's own trace, its input already redacted. Read-only: every change is an action.

import { assert } from '@ultimat3/core';
import { inspectJob, type JobRecord, jobCursor, MAX_JOB_PAGE } from '@ultimat3/jobs';
import { AdminFilterInvalidError } from '../errors';
import type { AdminListQuery, AdminRepo, AdminRow, KeysetBound } from '../registry';
import { JOBS_RESOURCE, jobWhere } from './job-where';
import { jobsOperator } from './operator';

/** The one order the store pages in. Any other is refused, never answered in this one. */
export const JOB_SORT = { field: 'createdAt', direction: 'desc' } as const;

const at = (ms: number | undefined): Date | null => (ms === undefined ? null : new Date(ms));

/** A row as a list shows it: no payload and no stack — those are the detail page's. */
export function jobRow(record: JobRecord): AdminRow {
  return {
    id: record.id,
    name: record.name,
    queue: record.queue,
    state: record.state,
    attempt: record.attempt,
    maxAttempts: record.maxAttempts,
    runAt: at(record.runAt),
    createdAt: at(record.createdAt),
    updatedAt: at(record.updatedAt),
    tenantId: record.tenantId ?? null,
    lastError: record.lastError ?? null,
    progress: record.progress ?? null,
    traceparent: record.traceparent ?? null,
    enqueuedBy: record.enqueuedBy ?? null,
    claimedBy: record.claimedBy ?? null,
  };
}

/** A keyset bound as the store's cursor: the bound row's instant in ms, and its id. */
const cursorOf = (bound: KeysetBound): string =>
  jobCursor({ createdAt: Date.parse(bound.value), id: bound.id });

function assertOrder(query: AdminListQuery): void {
  const { field, direction } = query.sort;
  if (field === JOB_SORT.field && direction === JOB_SORT.direction) return;
  throw new AdminFilterInvalidError({
    entity: JOBS_RESOURCE,
    asked: `sort=${field}:${direction}`,
    cause: 'is not an order the job store pages in — a job list is newest first',
    known: [`sort=${JOB_SORT.field}:${JOB_SORT.direction}`],
  });
}

async function list(query: AdminListQuery): Promise<readonly AdminRow[]> {
  assertOrder(query);
  const where = jobWhere(query.where ?? []);
  if (where.empty) return [];
  const { introspect } = jobsOperator();
  const records = await introspect.list({
    ...where.filter,
    // The admin asks one row past its page to learn whether there is a next one; the store's page
    // is bounded, and a full store page simply reads as "maybe more".
    limit: Math.min(query.limit, MAX_JOB_PAGE),
    ...(query.after === undefined ? {} : { after: cursorOf(query.after) }),
    ...(query.before === undefined ? {} : { before: cursorOf(query.before) }),
  });
  const exact = where.exactId;
  return (exact === undefined ? records : records.filter((record) => record.id === exact)).map(
    jobRow,
  );
}

/** The detail: the row, plus what `inspectJob` says of it — redacted input, steps, the stack. */
async function find(id: string): Promise<AdminRow | null> {
  const { driver, introspect } = jobsOperator();
  const [record, trace] = await Promise.all([introspect.job(id), inspectJob(driver, id)]);
  if (record === undefined || trace === undefined) return null;
  return {
    ...jobRow(record),
    input: trace.input ?? null,
    lastErrorStack: trace.stack,
    steps: trace.steps,
  };
}

/**
 * Unreachable through the admin — the resource offers list and detail only (`job-resources.ts`) —
 * so a call here is a caller that went round the route table: an invariant, not a refusal.
 */
const readOnly = async (): Promise<never> => {
  assert(
    false,
    'a job row was written through the admin repo, and the jobs resource offers no write',
    'change a job through its actions: admin.action.job.retry, .run-now, .cancel, .remove',
  );
};

export const jobRepo: AdminRepo<AdminRow> = {
  list,
  find,
  create: readOnly,
  update: readOnly,
  destroy: readOnly,
};
