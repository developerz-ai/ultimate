// The redis driver's `tenantJobs`: one Lua script each, fenced on the tenant inside the script, so
// another tenant's row and a missing one are the same nil reply from the same single `HMGET`.
// The cancel is `SQL_CANCEL`'s write in this driver's key layout (`driver-redis.ts`).

import { isJobState } from './driver';
import { ENDED, LIVE, NOW_OF } from './driver-redis-scripts';
import type { JobStatusRow, TenantJobs } from './job-status-port';

/** The fields a status reply carries, in this order. `progress` is not kept by this driver. */
const STATUS_FIELDS = `'id', 'name', 'state', 'attempt', 'maxAttempts', 'runAt', 'createdAt', 'updatedAt'`;

/**
 * `ARGV`: namespace, id, tenant, name (`''`: any). An absent `tenantId` field reads `false`, which
 * equals no tenant's string: a row queued for no tenant matches no tenant's call.
 */
const FENCE = `
local P = ARGV[1]
local id = ARGV[2]
local job = P .. ':job:' .. id
local owner = redis.call('HMGET', job, 'tenantId', 'name')
if owner[1] ~= ARGV[3] then return nil end
if ARGV[4] ~= '' and owner[2] ~= ARGV[4] then return nil end
`;

export const REDIS_STATUS_FOR = `
${FENCE}
return redis.call('HMGET', job, ${STATUS_FIELDS})
`.trim();

/**
 * `SQL_JOB_CANCEL_FOR`. `ARGV`: the fence's four, then the reason (`''`: keep `lastError`), now
 * (`NOW_OF`), a cancelled row's time to live. A live row leaves every queue set and frees its key
 * (`:idem`, as every ending does); a heartbeat or settle of the run's worker then finds it not
 * `running` and stops. Answers the row as it now stands.
 */
export const REDIS_CANCEL_FOR = `
${LIVE}
${NOW_OF}
${ENDED}
${FENCE}
local held = redis.call('HMGET', job, 'state', 'queue', 'nk', 'runId')
if LIVE[held[1]] then
  local now = now_of(ARGV[6])
  redis.call('HSET', job, 'state', 'cancelled', 'updatedAt', now)
  if ARGV[5] ~= '' then redis.call('HSET', job, 'lastError', ARGV[5]) end
  redis.call('HDEL', job, 'visibleAt', 'claimedBy')
  for _, set in ipairs({ 'wait', 'park', 'run' }) do
    redis.call('ZREM', P .. ':' .. set .. ':' .. held[2], id)
  end
  if redis.call('HGET', P .. ':idem', held[3]) == id then redis.call('HDEL', P .. ':idem', held[3]) end
  ended(P, id, held[3], held[4], tonumber(ARGV[7]), nil, now)
end
return redis.call('HMGET', job, ${STATUS_FIELDS})
`.trim();

/** An `HMGET` reply in `STATUS_FIELDS` order, or nothing for the nil a fence answers. */
function rowOf(reply: unknown): JobStatusRow | undefined {
  if (!Array.isArray(reply)) return undefined;
  const [id, name, state, attempt, maxAttempts, runAt, createdAt, updatedAt] = reply.map((value) =>
    value === null || value === undefined ? '' : String(value),
  );
  if (id === undefined || id === '') return undefined;
  return {
    id,
    name: name ?? '',
    // A state the list does not know reads as dead, as `toRecord` reads it: never a cast.
    state: state !== undefined && isJobState(state) ? state : 'dead',
    attempt: Number(attempt),
    maxAttempts: Number(maxAttempts),
    runAt: Number(runAt),
    createdAt: Number(createdAt),
    updatedAt: Number(updatedAt),
  };
}

export interface RedisTenantJobsSeams {
  /** One script, routed to the namespace's slot; the namespace is its first `ARGV`. */
  readonly run: (script: string, args: readonly (string | number)[]) => Promise<unknown>;
  /** "Now" as the scripts read it: an injected clock's instant, or `''` for the server's. */
  readonly stamp: () => number | string;
  /** How long a cancelled row outlives its cancel — the dead rows' window, as pg sweeps it. */
  readonly endedTtlMs: number;
}

export function redisTenantJobs({ run, stamp, endedTtlMs }: RedisTenantJobsSeams): TenantJobs {
  return {
    async status(query) {
      return rowOf(await run(REDIS_STATUS_FOR, [query.jobId, query.tenantId, query.name ?? '']));
    },
    async cancel(query, reason) {
      const args = [query.jobId, query.tenantId, query.name ?? '', reason ?? '', stamp()];
      return rowOf(await run(REDIS_CANCEL_FOR, [...args, endedTtlMs]));
    },
  };
}
