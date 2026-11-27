// The memory driver's `tenantJobs`: the fence over its own operator surface. One process, one
// map — the read and the cancel cannot interleave with another writer, and a row's tenant never
// changes after its enqueue, so fencing first and cancelling second is the pg statement's answer.

import type { JobRecord } from './driver';
import type { JobIntrospection } from './introspection';
import type { JobStatusRow, TenantJobQuery, TenantJobs } from './job-status-port';

/** `id = $1 and tenant_id = $2 and name = $3`, as the pg statement reads it: null never matches. */
const owned = (record: JobRecord | undefined, query: TenantJobQuery): record is JobRecord =>
  record !== undefined &&
  record.tenantId === query.tenantId &&
  (query.name === undefined || record.name === query.name);

/** The columns the fence answers, and nothing the record also carries. */
export function statusRowOf(record: JobRecord): JobStatusRow {
  return {
    id: record.id,
    name: record.name,
    state: record.state,
    attempt: record.attempt,
    maxAttempts: record.maxAttempts,
    runAt: record.runAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.progress === undefined ? {} : { progress: record.progress }),
  };
}

export function memoryTenantJobs(introspect: Pick<JobIntrospection, 'job' | 'cancel'>): TenantJobs {
  return {
    async status(query) {
      const record = await introspect.job(query.jobId);
      return owned(record, query) ? statusRowOf(record) : undefined;
    },
    async cancel(query, reason) {
      const record = await introspect.job(query.jobId);
      if (!owned(record, query)) return undefined;
      // `cancel` is fenced on the live states itself: a finished row comes back unchanged.
      const cancelled = await introspect.cancel?.(query.jobId, reason);
      return statusRowOf(cancelled ?? (await introspect.job(query.jobId)) ?? record);
    },
  };
}
