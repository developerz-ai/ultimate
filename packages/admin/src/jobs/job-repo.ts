// The job rows as an `AdminRepo`: a page is the store's own `JobIntrospection.list`, newest first
// and keyset by `(createdAt, id)` — the only order it answers — and a detail is the store's own
// trace, its input already redacted. Read-only: every change is an action.

import { assert } from '@ultimat3/core';
import {
  inspectJob,
  type JobFilter,
  type JobRecord,
  jobCursor,
  MAX_JOB_PAGE,
} from '@ultimat3/jobs';
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
  // `createdAt` is never NULL on a job row, so a bound without a value names no position: `NaN`
  // here, which the store refuses as an unreadable cursor rather than seeking from the epoch.
  jobCursor({
    createdAt: bound.value === null ? Number.NaN : Date.parse(bound.value),
    id: bound.id,
  });

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

/**
 * The rows one admin query asks for. The admin asks ONE row past its page to learn whether a next
 * one exists, and the store answers `MAX_JOB_PAGE` at most — so a 200-row page (the admin's own
 * ceiling, and what the MCP list tool accepts) was answered 200 rows, read as "no more", and every
 * row after it was on no page. Past the store's ceiling, the overflow is a second read from where
 * the first one stopped: after its last row walking forward, before its first walking back.
 */
async function records(filter: JobFilter, query: AdminListQuery): Promise<readonly JobRecord[]> {
  const { introspect } = jobsOperator();
  const backward = query.before !== undefined;
  const bound =
    query.after !== undefined
      ? { after: cursorOf(query.after) }
      : query.before !== undefined
        ? { before: cursorOf(query.before) }
        : {};
  const first = await introspect.list({
    ...filter,
    limit: Math.min(query.limit, MAX_JOB_PAGE),
    ...bound,
  });
  const over = query.limit - MAX_JOB_PAGE;
  if (over <= 0 || first.length < MAX_JOB_PAGE) return first;
  const edge = backward ? first[0] : first[first.length - 1];
  if (edge === undefined) return first;
  const more = await introspect.list({
    ...filter,
    limit: Math.min(over, MAX_JOB_PAGE),
    ...(backward ? { before: jobCursor(edge) } : { after: jobCursor(edge) }),
  });
  return backward ? [...more, ...first] : [...first, ...more];
}

async function list(query: AdminListQuery): Promise<readonly AdminRow[]> {
  assertOrder(query);
  const where = jobWhere(query.where ?? []);
  if (where.empty) return [];
  const found = await records(where.filter, query);
  const exact = where.exactId;
  return (exact === undefined ? found : found.filter((record) => record.id === exact)).map(jobRow);
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
