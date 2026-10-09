// The Redis job driver's statements: one Lua script per queue operation, so each runs atomically
// on the server the way each `driver-pg-sql.ts` statement runs in one transaction. The TypeScript
// that binds their arguments, and the key layout they share, is `driver-redis.ts`.
//
// Every key a script touches carries the namespace's `{hash tag}`, so all of them live in ONE slot
// and a script is legal on Redis Cluster and Dragonfly alike: `KEYS[1]` is always a namespaced key,
// which is what routes the call, and the others are built from `ARGV[1]` inside the slot it named.

import { LEASE_LAPSED_FINAL_ATTEMPT } from './driver';

/**
 * The live states as a Lua set, the four `LIVE_STATES` names — the idempotency namespace holds a
 * key only while one of them does, exactly as `x_jobs_name_tenant_idempotency_live_idx` does.
 */
const LIVE = `local LIVE = { ready = true, delayed = true, running = true, suspended = true }`;

/**
 * The claim fence `SQL_ACK` carries: the row is `running`, held by this worker, under this claim.
 * `ARGV[1]` namespace, `ARGV[2]` id, `ARGV[3]` worker, `ARGV[4]` claim ordinal.
 */
const FENCE = `
local P = ARGV[1]
local id = ARGV[2]
local job = P .. ':job:' .. id
local held = redis.call('HMGET', job, 'state', 'claimedBy', 'claim', 'queue', 'nk', 'runId')
if held[1] ~= 'running' or held[2] ~= ARGV[3] or held[3] ~= ARGV[4] then return 0 end
local queue = held[4]
redis.call('HDEL', job, 'visibleAt', 'claimedBy')
redis.call('ZREM', P .. ':run:' .. queue, id)
`;

/**
 * `ARGV`: namespace, id, name, queue, input, idempotency key, runId, maxAttempts, runAt, now,
 * tenant, traceparent, enqueuedBy, namespace field. Answers `{ outcome, id, runId }`: `published`
 * when the caller-allocated id already names a row (`SQL_ENQUEUE`'s `not exists`), `deduped` when
 * a live row holds the key, `created` otherwise.
 */
export const REDIS_ENQUEUE = `
${LIVE}
local P = ARGV[1]
local id = ARGV[2]
local job = P .. ':job:' .. id
if redis.call('EXISTS', job) == 1 then
  return { 'published', id, redis.call('HGET', job, 'runId') }
end
local nk = ARGV[14]
local holder = redis.call('HGET', P .. ':idem', nk)
if holder then
  local row = redis.call('HMGET', P .. ':job:' .. holder, 'state', 'runId')
  if row[1] and LIVE[row[1]] then return { 'deduped', holder, row[2] } end
end
local now = tonumber(ARGV[10])
local runAt = tonumber(ARGV[9])
local state = 'ready'
if runAt > now then state = 'delayed' end
redis.call('HSET', job,
  'id', id, 'name', ARGV[3], 'queue', ARGV[4], 'input', ARGV[5], 'idempotencyKey', ARGV[6],
  'runId', ARGV[7], 'attempt', '0', 'maxAttempts', ARGV[8], 'state', state, 'runAt', ARGV[9],
  'createdAt', ARGV[10], 'updatedAt', ARGV[10], 'claim', '0', 'nk', nk)
if ARGV[11] ~= '' then redis.call('HSET', job, 'tenantId', ARGV[11]) end
if ARGV[12] ~= '' then redis.call('HSET', job, 'traceparent', ARGV[12]) end
if ARGV[13] ~= '' then redis.call('HSET', job, 'enqueuedBy', ARGV[13]) end
redis.call('ZADD', P .. ':wait:' .. ARGV[4], runAt, id)
redis.call('SADD', P .. ':queues', ARGV[4])
redis.call('HSET', P .. ':idem', nk, id)
return { 'created', id, ARGV[7] }
`.trim();

/**
 * `SQL_CLAIM`. `ARGV`: namespace, now, limit, visibility ms, worker, the count of `dropExhausted`
 * names, those names, then the queues. Candidates are every due row of each queue — ready,
 * delayed, suspended, or running past its lease — at most `limit` from each source, ordered by
 * `runAt` and cut at `limit`. A running row on its final attempt is BURIED (`dead`, or `failed`
 * for a dropped name) and never handed out. Answers one `{ 'c' | 'b', HGETALL… }` per row.
 */
export const REDIS_CLAIM = `
local P = ARGV[1]
local now = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local visibility = tonumber(ARGV[4])
local worker = ARGV[5]
local dropCount = tonumber(ARGV[6])
local drop = {}
for i = 1, dropCount do drop[ARGV[6 + i]] = true end
local candidates = {}
if limit > 0 then
  for i = 7 + dropCount, #ARGV do
    local queue = ARGV[i]
    for _, source in ipairs({ 'wait', 'park' }) do
      local found = redis.call('ZRANGEBYSCORE', P .. ':' .. source .. ':' .. queue, '-inf', now,
        'WITHSCORES', 'LIMIT', 0, limit)
      for j = 1, #found, 2 do
        table.insert(candidates, { id = found[j], runAt = tonumber(found[j + 1]) })
      end
    end
    local lapsed = redis.call('ZRANGEBYSCORE', P .. ':run:' .. queue, '-inf', now, 'LIMIT', 0, limit)
    for _, id in ipairs(lapsed) do
      local runAt = tonumber(redis.call('HGET', P .. ':job:' .. id, 'runAt'))
      if runAt and runAt <= now then table.insert(candidates, { id = id, runAt = runAt }) end
    end
  end
end
table.sort(candidates, function(a, b)
  if a.runAt == b.runAt then return a.id < b.id end
  return a.runAt < b.runAt
end)
local out = {}
for i = 1, math.min(limit, #candidates) do
  local id = candidates[i].id
  local job = P .. ':job:' .. id
  local row = redis.call('HMGET', job, 'state', 'attempt', 'maxAttempts', 'name', 'queue', 'claim', 'nk')
  local state, attempt, maxAttempts, name, queue = row[1], tonumber(row[2]), tonumber(row[3]), row[4], row[5]
  if state == 'running' and attempt >= maxAttempts then
    local final = 'dead'
    if drop[name] then final = 'failed' end
    redis.call('ZREM', P .. ':run:' .. queue, id)
    redis.call('HDEL', job, 'visibleAt', 'claimedBy', 'lastErrorStack')
    redis.call('HSET', job, 'state', final, 'lastError', '${LEASE_LAPSED_FINAL_ATTEMPT}',
      'updatedAt', ARGV[2])
    redis.call('ZADD', P .. ':' .. final .. ':' .. queue, now, id)
    redis.call('HDEL', P .. ':idem', row[7])
    table.insert(out, { 'b', redis.call('HGETALL', job) })
  else
    redis.call('ZREM', P .. ':wait:' .. queue, id)
    redis.call('ZREM', P .. ':park:' .. queue, id)
    local visibleAt = now + visibility
    redis.call('HSET', job, 'state', 'running', 'attempt', attempt + 1,
      'claim', tonumber(row[6]) + 1, 'claimedBy', worker, 'claimedAt', ARGV[2],
      'visibleAt', visibleAt, 'updatedAt', ARGV[2])
    redis.call('ZADD', P .. ':run:' .. queue, visibleAt, id)
    table.insert(out, { 'c', redis.call('HGETALL', job) })
  end
end
return out
`.trim();

/** `SQL_ACK`. `ARGV`: the fence's four, then now, then the done row's time to live (0: none). */
export const REDIS_ACK = `
${FENCE}
redis.call('HSET', job, 'state', 'done', 'updatedAt', ARGV[5])
redis.call('HDEL', P .. ':idem', held[5])
local ttl = tonumber(ARGV[6])
if ttl > 0 then
  redis.call('PEXPIRE', job, ttl)
  redis.call('PEXPIRE', P .. ':steps:' .. held[6], ttl)
end
return 1
`.trim();

/**
 * `SQL_NACK`. `ARGV`: the fence's four, then now, the state `nackState` chose, runAt, `1` when the
 * attempt counts, `1` when an error is bound, the error, the stack (`''` for none).
 */
export const REDIS_NACK = `
${FENCE}
local state = ARGV[6]
local attempt = tonumber(redis.call('HGET', job, 'attempt'))
if ARGV[8] ~= '1' then attempt = math.max(0, attempt - 1) end
redis.call('HSET', job, 'state', state, 'runAt', ARGV[7], 'attempt', attempt, 'updatedAt', ARGV[5])
if ARGV[9] == '1' then
  redis.call('HSET', job, 'lastError', ARGV[10])
  if ARGV[11] == '' then redis.call('HDEL', job, 'lastErrorStack')
  else redis.call('HSET', job, 'lastErrorStack', ARGV[11]) end
end
if state == 'ready' then
  redis.call('ZADD', P .. ':wait:' .. queue, ARGV[7], id)
elseif state == 'suspended' then
  redis.call('ZADD', P .. ':park:' .. queue, ARGV[7], id)
else
  redis.call('ZADD', P .. ':' .. state .. ':' .. queue, ARGV[5], id)
  redis.call('HDEL', P .. ':idem', held[5])
end
return 1
`.trim();

/**
 * `SQL_HEARTBEAT`. `ARGV`: namespace, id, worker (`''`: any), claim (`''`: any), the new lease's
 * end. Answers 1 when the lease moved.
 */
export const REDIS_HEARTBEAT = `
local P = ARGV[1]
local id = ARGV[2]
local job = P .. ':job:' .. id
local held = redis.call('HMGET', job, 'state', 'claimedBy', 'claim', 'queue')
if held[1] ~= 'running' then return 0 end
if ARGV[3] ~= '' and held[2] ~= ARGV[3] then return 0 end
if ARGV[4] ~= '' and held[3] ~= ARGV[4] then return 0 end
redis.call('HSET', job, 'visibleAt', ARGV[5])
redis.call('ZADD', P .. ':run:' .. held[4], ARGV[5], id)
return 1
`.trim();

/**
 * `SQL_STATS`, one consistent read. `ARGV`: namespace, now. Answers one row per queue:
 * `{ queue, ready, delayed, running, suspended, failed, dead, oldest runAt or -1 }` — due is due
 * whatever state the row was WRITTEN in, the split `SQL_STATS` makes.
 */
export const REDIS_STATS = `
local P = ARGV[1]
local now = tonumber(ARGV[2])
local out = {}
for _, queue in ipairs(redis.call('SMEMBERS', P .. ':queues')) do
  local wait = P .. ':wait:' .. queue
  local oldest = redis.call('ZRANGE', wait, 0, 0, 'WITHSCORES')
  local first = -1
  if oldest[2] and tonumber(oldest[2]) <= now then first = oldest[2] end
  table.insert(out, {
    queue,
    redis.call('ZCOUNT', wait, '-inf', now),
    redis.call('ZCOUNT', wait, '(' .. now, '+inf'),
    redis.call('ZCARD', P .. ':run:' .. queue),
    redis.call('ZCARD', P .. ':park:' .. queue),
    redis.call('ZCARD', P .. ':failed:' .. queue),
    redis.call('ZCARD', P .. ':dead:' .. queue),
    first,
  })
end
return out
`.trim();

/**
 * `SQL_STEP_PUT` under a claim: the write lands only while that claim still holds the row.
 * `ARGV`: namespace, job id, worker, claim, runId, step name, the record as JSON.
 */
export const REDIS_STEP_PUT_FENCED = `
local P = ARGV[1]
local held = redis.call('HMGET', P .. ':job:' .. ARGV[2], 'state', 'claimedBy', 'claim')
if held[1] ~= 'running' or held[2] ~= ARGV[3] or held[3] ~= ARGV[4] then return 0 end
redis.call('HSET', P .. ':steps:' .. ARGV[5], ARGV[6], ARGV[7])
return 1
`.trim();
