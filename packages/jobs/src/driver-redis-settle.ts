// The Redis driver's `onSettled` debt (J11): the `owed` ZSET `REDIS_ACK` and an ending `REDIS_NACK`
// add a row to, by the time it was owed — `x_jobs.settle_owed` and its partial index in one key.
// Paid by `REDIS_SETTLE_CLEAR`, re-driven off `REDIS_SETTLE_TAKE_LOST`, as the pg statements are.

import type { Clock } from '@ultimat3/core';
import { nowMs } from './clock';
import type { JobRecord } from './driver';
import type { SettleDebt } from './driver-settle';

/** How many owed ids one take reads at most, hooked or not: the script's bound on its own work. */
export const REDIS_SETTLE_SCAN = 1_000;

/**
 * `SQL_SETTLE_CLEAR`. `ARGV`: namespace, id, the claim. Fenced on the claim the row still carries,
 * so a row requeued and claimed again since keeps its debt. Answers 1 when a debt was paid.
 */
export const REDIS_SETTLE_CLEAR = `
local P = ARGV[1]
local id = ARGV[2]
if redis.call('HGET', P .. ':job:' .. id, 'claim') ~= ARGV[3] then return 0 end
return redis.call('ZREM', P .. ':owed', id)
`.trim();

/**
 * `SQL_SETTLE_TAKE_LOST`. `ARGV`: namespace, now, limit, then `name, graceMs` pairs. Oldest debts
 * first; each one taken has its time reset to now. An id whose row expired (`doneTtlMs`) is
 * dropped, and a row requeued since — live again — is left owed and not handed out.
 */
export const REDIS_SETTLE_TAKE_LOST = `
local P = ARGV[1]
local now = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local grace = {}
local least = nil
for i = 4, #ARGV - 1, 2 do
  local g = tonumber(ARGV[i + 1])
  grace[ARGV[i]] = g
  if least == nil or g < least then least = g end
end
if least == nil or limit <= 0 then return {} end
local ENDED = { done = true, dead = true, failed = true }
local owed = P .. ':owed'
local out = {}
local ids = redis.call('ZRANGEBYSCORE', owed, '-inf', now - least, 'WITHSCORES', 'LIMIT', 0, ${REDIS_SETTLE_SCAN})
for i = 1, #ids, 2 do
  if #out >= limit then break end
  local id = ids[i]
  local job = P .. ':job:' .. id
  local row = redis.call('HMGET', job, 'name', 'state')
  if not row[1] then
    redis.call('ZREM', owed, id)
  else
    local g = grace[row[1]]
    if g and ENDED[row[2]] and tonumber(ids[i + 1]) <= now - g then
      redis.call('ZADD', owed, now, id)
      table.insert(out, redis.call('HGETALL', job))
    end
  end
end
return out
`.trim();

export interface RedisSettleDebtOptions {
  /** The driver's script runner: namespace first, then `args`. */
  readonly run: (script: string, args: readonly (string | number)[]) => Promise<unknown>;
  readonly clock: Clock;
  /** One `HGETALL` reply as the record every driver hands back. */
  readonly record: (flat: readonly unknown[]) => JobRecord;
}

export function redisSettleDebt(options: RedisSettleDebtOptions): SettleDebt {
  return {
    async clear(jobId, claim) {
      return Number(await options.run(REDIS_SETTLE_CLEAR, [jobId, claim])) === 1;
    },
    async takeLost(jobs, limit) {
      if (jobs.length === 0 || limit <= 0) return [];
      const pairs = jobs.flatMap((job) => [job.name, Math.round(job.graceMs)]);
      const reply = await options.run(REDIS_SETTLE_TAKE_LOST, [
        nowMs(options.clock),
        limit,
        ...pairs,
      ]);
      return (Array.isArray(reply) ? reply : []).map((flat: unknown) =>
        options.record(Array.isArray(flat) ? flat : []),
      );
    },
  };
}
