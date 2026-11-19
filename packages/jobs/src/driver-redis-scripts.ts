// The Redis job driver's statements: one Lua script per queue operation, so each runs atomically
// on the server the way each `driver-pg-sql.ts` statement runs in one transaction. The TypeScript
// that binds their arguments, and the key layout they share, is `driver-redis.ts`.
//
// Every key a script touches carries the namespace's `{hash tag}`, so all of them live in ONE slot
// and a script is legal on Redis Cluster and Dragonfly alike: `KEYS[1]` is always a namespaced key,
// which is what routes the call, and the others are built from `ARGV[1]` inside the slot it named.

import { JOB_EXPIRED, LEASE_LAPSED_FINAL_ATTEMPT } from './driver';

/**
 * The live states as a Lua set, the four `LIVE_STATES` names — the idempotency namespace holds a
 * key only while one of them does, exactly as `x_jobs_name_tenant_idempotency_live_idx` does.
 */
const LIVE = `local LIVE = { ready = true, delayed = true, running = true, suspended = true }`;

/**
 * "Now" for a script: the instant the driver bound, or `''` for the SERVER's own (`TIME`) — what
 * every pod reads alike, as pg's `now()` is. A lease measured on each pod's clock let a pod running
 * ahead claim a row another still held. Bound only when a clock was injected (a test's frozen one).
 */
export const NOW_OF = `
local function now_of(arg)
  if arg ~= '' then return tonumber(arg) end
  local t = redis.call('TIME')
  return tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end
`;

/**
 * A row that ended: its hash, its steps and its debounce fence expire together after `ttl` ms
 * (`0`: kept), and an ended set (`dead:<queue>`/`failed:<queue>`, by time) sheds members older
 * than that — the window pg's `jobs-retention.ts` sweeps. `set` is `nil` for `done`, which has none.
 */
const ENDED = `
local function ended(P, id, nk, runId, ttl, set, now)
  if ttl <= 0 then return end
  redis.call('PEXPIRE', P .. ':job:' .. id, ttl)
  redis.call('PEXPIRE', P .. ':steps:' .. runId, ttl)
  local fence = P .. ':debounce:' .. nk
  if redis.call('GET', fence) == id then redis.call('PEXPIRE', fence, ttl) end
  if redis.call('HGET', P .. ':debounce', nk) == id then
    redis.call('HDEL', P .. ':debounce', nk)
    redis.call('SET', fence, id, 'PX', ttl)
  end
  if set then redis.call('ZREMRANGEBYSCORE', set, '-inf', '(' .. (now - ttl)) end
end
`;

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
 * One enqueue, as a Lua function both enqueue scripts call, so the single and the batch insert are
 * ONE body. `a[o]` onwards, `ENQUEUE_ARITY` fields: id, name, queue, input, idempotency key,
 * runId, maxAttempts, runAt, now, tenant, traceparent, enqueuedBy, namespace field, expiresAt
 * (`''`: none), `'1'` for `onConflict: 'replace'`. Answers `{ outcome, id, runId }`: `published`
 * when the caller-allocated id already names a row (`SQL_ENQUEUE`'s `not exists`), `replaced` when
 * a waiting holder took this input and runAt (`SQL_ENQUEUE_REPLACE`), `deduped` when a live row
 * holds the key otherwise, `created` otherwise.
 *
 * The debounce fence is `SQL_ENQUEUE_REPLACE`'s: a job hash's `debounced` field is the id of the
 * request whose input it holds, and `:debounce:<key>` names the last row a replace wrote — kept
 * past the run, so a replace published again after its holder finished meets it, and expiring WITH
 * that row (`ended`): one key per distinct key ever debounced, kept forever, was the leak. An entry
 * whose row is gone is dropped where it is found, as `newer` stops matching a pruned pg row. A
 * field of the `:debounce` HASH is the same fence as written before 31.x, read until it is moved.
 */
const ENQUEUE_ONE = `
${LIVE}
local function stamp_of(job, id)
  return redis.call('HGET', job, 'debounced') or id
end
local function enqueue_one(P, a, o)
  local id = a[o]
  local job = P .. ':job:' .. id
  if redis.call('EXISTS', job) == 1 then
    return { 'published', id, redis.call('HGET', job, 'runId') }
  end
  local nk = a[o + 12]
  local replace = a[o + 14] == '1'
  local fence = P .. ':debounce:' .. nk
  if replace then
    local last = redis.call('GET', fence) or redis.call('HGET', P .. ':debounce', nk)
    if last then
      local row = redis.call('HMGET', P .. ':job:' .. last, 'debounced', 'runId')
      if not row[1] then
        redis.call('DEL', fence)
        redis.call('HDEL', P .. ':debounce', nk)
      elseif row[1] >= id then return { 'deduped', last, row[2] } end
    end
  end
  local now = tonumber(a[o + 8])
  local runAt = tonumber(a[o + 7])
  local state = 'ready'
  if runAt > now then state = 'delayed' end
  local holder = redis.call('HGET', P .. ':idem', nk)
  if holder then
    local held = P .. ':job:' .. holder
    local row = redis.call('HMGET', held, 'state', 'runId', 'queue')
    if row[1] and LIVE[row[1]] then
      if replace and (row[1] == 'ready' or row[1] == 'delayed') and stamp_of(held, holder) < id then
        redis.call('HSET', held, 'input', a[o + 3], 'runAt', a[o + 7], 'state', state,
          'updatedAt', a[o + 8], 'debounced', id)
        if a[o + 13] ~= '' then redis.call('HSET', held, 'expiresAt', a[o + 13])
        else redis.call('HDEL', held, 'expiresAt') end
        redis.call('ZADD', P .. ':wait:' .. row[3], runAt, holder)
        redis.call('SET', fence, holder)
        redis.call('HDEL', P .. ':debounce', nk)
        return { 'replaced', holder, row[2] }
      end
      return { 'deduped', holder, row[2] }
    end
  end
  local queue = a[o + 2]
  redis.call('HSET', job,
    'id', id, 'name', a[o + 1], 'queue', queue, 'input', a[o + 3], 'idempotencyKey', a[o + 4],
    'runId', a[o + 5], 'attempt', '0', 'maxAttempts', a[o + 6], 'state', state,
    'runAt', a[o + 7], 'createdAt', a[o + 8], 'updatedAt', a[o + 8], 'claim', '0', 'nk', nk)
  if a[o + 9] ~= '' then redis.call('HSET', job, 'tenantId', a[o + 9]) end
  if a[o + 10] ~= '' then redis.call('HSET', job, 'traceparent', a[o + 10]) end
  if a[o + 11] ~= '' then redis.call('HSET', job, 'enqueuedBy', a[o + 11]) end
  if a[o + 13] ~= '' then redis.call('HSET', job, 'expiresAt', a[o + 13]) end
  if replace then
    redis.call('HSET', job, 'debounced', id)
    redis.call('SET', fence, id)
    redis.call('HDEL', P .. ':debounce', nk)
  end
  redis.call('ZADD', P .. ':wait:' .. queue, runAt, id)
  redis.call('SADD', P .. ':queues', queue)
  redis.call('HSET', P .. ':idem', nk, id)
  return { 'created', id, a[o + 5] }
end
`;

/**
 * Whether a LIVE row holds a key — `SQL_FIND_LIVE_BY_KEY`. `ARGV`: namespace, the namespace field.
 * `:idem` is cleared by every ending settle, so its entry is checked against the row's state only
 * for the row that expired out from under it.
 */
export const REDIS_HOLDS = `
${LIVE}
local holder = redis.call('HGET', ARGV[1] .. ':idem', ARGV[2])
if not holder then return 0 end
local state = redis.call('HGET', ARGV[1] .. ':job:' .. holder, 'state')
if state and LIVE[state] then return 1 end
return 0
`.trim();

/** Fields one request binds, after the namespace — what `ENQUEUE_ONE` reads from `a[o]` on. */
export const ENQUEUE_ARITY = 15;

/** `SQL_ENQUEUE`. `ARGV`: namespace, then one request's `ENQUEUE_ARITY` fields. */
export const REDIS_ENQUEUE = `
${ENQUEUE_ONE}
return enqueue_one(ARGV[1], ARGV, 2)
`.trim();

/**
 * `SQL_ENQUEUE_MANY`: every request in ONE script, so the batch is atomic on the server and a key
 * twice in it is one job — the second request meets the first's `idem` entry. `ARGV`: namespace,
 * then `ENQUEUE_ARITY` fields per request, in request order. Answers the three fields
 * `enqueue_one` answers, per request, flat and in order.
 */
export const REDIS_ENQUEUE_MANY = `
${ENQUEUE_ONE}
local out = {}
for o = 2, #ARGV, ${ENQUEUE_ARITY} do
  local answer = enqueue_one(ARGV[1], ARGV, o)
  table.insert(out, answer[1])
  table.insert(out, answer[2])
  table.insert(out, answer[3])
end
return out
`.trim();

/**
 * `SQL_CLAIM`. `ARGV`: namespace, now (`NOW_OF`), limit, visibility ms, worker, `'1'` to answer the
 * horizon (`SQL_CLAIM_IDLE`), an ended row's time to live (`ENDED`), the count of `dropExhausted`
 * names, those names, the count of `settleOwed` names, those names, then the queues.
 * Candidates are every due row of each queue — ready, delayed, suspended, or running past its
 * lease — at most `limit` from each source, ordered by `runAt` and cut at `limit`. A running row
 * on its final attempt is BURIED (`dead`, or `failed` for a dropped name) and never handed out;
 * a waiting row never claimed (`attempt` 0) past its `expiresAt` is settled `failed` with
 * `JOB_EXPIRED` and answered the same. Either burial of a `settleOwed` name owes its `onSettled`
 * in the same script (`owed`, `driver-redis-settle.ts`), as `SQL_CLAIM`'s `$6` does.
 * Answers `{ 'c', HGETALL…, HVALS steps… }` per claimed row, `{ 'b', HGETALL… }` per buried one;
 * with nothing taken and the horizon asked, ONE `{ 'h', ms until the first waiting row's runAt or
 * held lease's visibleAt }`, `{ 'h' }` when no row waits or is held.
 */
export const REDIS_CLAIM = `
${NOW_OF}
${ENDED}
local P = ARGV[1]
local now = now_of(ARGV[2])
local limit = tonumber(ARGV[3])
local visibility = tonumber(ARGV[4])
local worker = ARGV[5]
local horizon = ARGV[6] == '1'
local endedTtl = tonumber(ARGV[7])
local dropCount = tonumber(ARGV[8])
local drop = {}
for i = 1, dropCount do drop[ARGV[8 + i]] = true end
local owesCount = tonumber(ARGV[9 + dropCount])
local owes = {}
for i = 1, owesCount do owes[ARGV[9 + dropCount + i]] = true end
local first = 10 + dropCount + owesCount
local function bury(id, name, nk, runId, set)
  if owes[name] then redis.call('ZADD', P .. ':owed', now, id)
  else redis.call('ZREM', P .. ':owed', id) end
  ended(P, id, nk, runId, endedTtl, set, now)
end
local candidates = {}
if limit > 0 then
  for i = first, #ARGV do
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
  local row = redis.call('HMGET', job, 'state', 'attempt', 'maxAttempts', 'name', 'queue', 'claim', 'nk',
    'runId', 'expiresAt')
  local state, attempt, maxAttempts, name, queue = row[1], tonumber(row[2]), tonumber(row[3]), row[4], row[5]
  local expiresAt = tonumber(row[9])
  if (state == 'ready' or state == 'delayed') and attempt == 0 and expiresAt and expiresAt <= now then
    redis.call('ZREM', P .. ':wait:' .. queue, id)
    redis.call('HDEL', job, 'lastErrorStack')
    redis.call('HSET', job, 'state', 'failed', 'lastError', '${JOB_EXPIRED}', 'updatedAt', now)
    redis.call('ZADD', P .. ':failed:' .. queue, now, id)
    redis.call('HDEL', P .. ':idem', row[7])
    bury(id, name, row[7], row[8], P .. ':failed:' .. queue)
    table.insert(out, { 'b', redis.call('HGETALL', job) })
  elseif state == 'running' and attempt >= maxAttempts then
    local final = 'dead'
    if drop[name] then final = 'failed' end
    redis.call('ZREM', P .. ':run:' .. queue, id)
    redis.call('HDEL', job, 'visibleAt', 'claimedBy', 'lastErrorStack')
    redis.call('HSET', job, 'state', final, 'lastError', '${LEASE_LAPSED_FINAL_ATTEMPT}',
      'updatedAt', now)
    redis.call('ZADD', P .. ':' .. final .. ':' .. queue, now, id)
    redis.call('HDEL', P .. ':idem', row[7])
    bury(id, name, row[7], row[8], P .. ':' .. final .. ':' .. queue)
    table.insert(out, { 'b', redis.call('HGETALL', job) })
  else
    redis.call('ZREM', P .. ':wait:' .. queue, id)
    redis.call('ZREM', P .. ':park:' .. queue, id)
    local visibleAt = now + visibility
    redis.call('HSET', job, 'state', 'running', 'attempt', attempt + 1,
      'claim', tonumber(row[6]) + 1, 'claimedBy', worker, 'claimedAt', now,
      'visibleAt', visibleAt, 'updatedAt', now)
    redis.call('ZADD', P .. ':run:' .. queue, visibleAt, id)
    table.insert(out, { 'c', redis.call('HGETALL', job), redis.call('HVALS', P .. ':steps:' .. row[8]) })
  end
end
if #out == 0 and horizon then
  local soonest = nil
  for i = first, #ARGV do
    for _, source in ipairs({ 'wait', 'park', 'run' }) do
      local head = redis.call('ZRANGE', P .. ':' .. source .. ':' .. ARGV[i], 0, 0, 'WITHSCORES')
      local at = tonumber(head[2])
      if at and (soonest == nil or at < soonest) then soonest = at end
    end
  end
  if soonest == nil then return { { 'h' } } end
  return { { 'h', soonest - now } }
end
return out
`.trim();

/**
 * `SQL_ACK`. `ARGV`: the fence's four, then now (`NOW_OF`), the done row's time to live (0: none),
 * `1` when the job declares `onSettled` — its debt, in `owed` by time (`driver-redis-settle.ts`).
 */
export const REDIS_ACK = `
${NOW_OF}
${ENDED}
${FENCE}
local now = now_of(ARGV[5])
redis.call('HSET', job, 'state', 'done', 'updatedAt', now)
if ARGV[7] == '1' then redis.call('ZADD', P .. ':owed', now, id)
else redis.call('ZREM', P .. ':owed', id) end
redis.call('HDEL', P .. ':idem', held[5])
ended(P, id, held[5], held[6], tonumber(ARGV[6]), nil, now)
return 1
`.trim();

/**
 * `SQL_NACK`. `ARGV`: the fence's four, then now (`NOW_OF`), the state `nackState` chose, the delay
 * ms (runAt is now plus it, `SQL_NACK`'s `now() + $4`), `1` when the attempt counts, `1` when an
 * error is bound, the error, the stack (`''` for none), `1` when the job declares `onSettled` —
 * owed only by an ending state, as `SQL_NACK` reads it — then an ended row's time to live.
 */
export const REDIS_NACK = `
${NOW_OF}
${ENDED}
${FENCE}
local now = now_of(ARGV[5])
local runAt = now + tonumber(ARGV[7])
local state = ARGV[6]
local attempt = tonumber(redis.call('HGET', job, 'attempt'))
if ARGV[8] ~= '1' then attempt = math.max(0, attempt - 1) end
redis.call('HSET', job, 'state', state, 'runAt', runAt, 'attempt', attempt, 'updatedAt', now)
if ARGV[9] == '1' then
  redis.call('HSET', job, 'lastError', ARGV[10])
  if ARGV[11] == '' then redis.call('HDEL', job, 'lastErrorStack')
  else redis.call('HSET', job, 'lastErrorStack', ARGV[11]) end
end
if state == 'ready' then
  redis.call('ZADD', P .. ':wait:' .. queue, runAt, id)
elseif state == 'suspended' then
  redis.call('ZADD', P .. ':park:' .. queue, runAt, id)
else
  local set = P .. ':' .. state .. ':' .. queue
  redis.call('ZADD', set, now, id)
  redis.call('HDEL', P .. ':idem', held[5])
  ended(P, id, held[5], held[6], tonumber(ARGV[13]), set, now)
end
if ARGV[12] == '1' and state ~= 'ready' and state ~= 'suspended' then
  redis.call('ZADD', P .. ':owed', now, id)
else redis.call('ZREM', P .. ':owed', id) end
return 1
`.trim();

/**
 * `SQL_HEARTBEAT`. `ARGV`: namespace, id, worker (`''`: any), claim (`''`: any), now (`NOW_OF`),
 * the visibility ms the lease runs from now. Answers 1 when the lease moved.
 */
export const REDIS_HEARTBEAT = `
${NOW_OF}
local P = ARGV[1]
local id = ARGV[2]
local job = P .. ':job:' .. id
local held = redis.call('HMGET', job, 'state', 'claimedBy', 'claim', 'queue')
if held[1] ~= 'running' then return 0 end
if ARGV[3] ~= '' and held[2] ~= ARGV[3] then return 0 end
if ARGV[4] ~= '' and held[3] ~= ARGV[4] then return 0 end
local visibleAt = now_of(ARGV[5]) + tonumber(ARGV[6])
redis.call('HSET', job, 'visibleAt', visibleAt)
redis.call('ZADD', P .. ':run:' .. held[4], visibleAt, id)
return 1
`.trim();

/**
 * `SQL_STATS`, one consistent read. `ARGV`: namespace, now (`NOW_OF`), an ended row's time to live:
 * an ended set's members past it are shed first, so the count is what retention keeps. Answers one
 * row per queue: `{ queue, ready, delayed, running, suspended, failed, dead, the oldest due row's
 * age in ms or -1 }` — due is due
 * whatever state the row was WRITTEN in, the split `SQL_STATS` makes. A queue all six counts leave
 * at zero is not answered: `SQL_STATS` reads only the states it counts, so a queue holding only
 * finished jobs is absent there and in the memory driver, and `:queues` never forgets a name.
 */
export const REDIS_STATS = `
${NOW_OF}
local P = ARGV[1]
local now = now_of(ARGV[2])
local ttl = tonumber(ARGV[3])
local out = {}
for _, queue in ipairs(redis.call('SMEMBERS', P .. ':queues')) do
  local wait = P .. ':wait:' .. queue
  if ttl > 0 then
    for _, set in ipairs({ 'failed', 'dead' }) do
      redis.call('ZREMRANGEBYSCORE', P .. ':' .. set .. ':' .. queue, '-inf', '(' .. (now - ttl))
    end
  end
  local oldest = redis.call('ZRANGE', wait, 0, 0, 'WITHSCORES')
  local first = -1
  if oldest[2] and tonumber(oldest[2]) <= now then first = now - tonumber(oldest[2]) end
  local row = {
    queue,
    redis.call('ZCOUNT', wait, '-inf', now),
    redis.call('ZCOUNT', wait, '(' .. now, '+inf'),
    redis.call('ZCARD', P .. ':run:' .. queue),
    redis.call('ZCARD', P .. ':park:' .. queue),
    redis.call('ZCARD', P .. ':failed:' .. queue),
    redis.call('ZCARD', P .. ':dead:' .. queue),
    first,
  }
  if row[2] + row[3] + row[4] + row[5] + row[6] + row[7] > 0 then table.insert(out, row) end
end
return out
`.trim();

/**
 * `SQL_QUEUE_DEMAND`, one consistent read. `ARGV`: namespace, now (`NOW_OF`). Answers `{ queue, demand }` per
 * queue with some: every running row plus every due wait or park row. This driver keeps no worker
 * registry and no pause, so no claimer is known to drain and no queue is paused: the rule
 * `SQL_QUEUE_DEMAND` applies to a claimer with no live row, which counts.
 */
export const REDIS_DEMAND = `
${NOW_OF}
local P = ARGV[1]
local now = now_of(ARGV[2])
local out = {}
for _, queue in ipairs(redis.call('SMEMBERS', P .. ':queues')) do
  local demand = redis.call('ZCARD', P .. ':run:' .. queue)
    + redis.call('ZCOUNT', P .. ':wait:' .. queue, '-inf', now)
    + redis.call('ZCOUNT', P .. ':park:' .. queue, '-inf', now)
  if demand > 0 then table.insert(out, { queue, demand }) end
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
