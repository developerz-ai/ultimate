// A Redis queue on core's `redisClient()` — no client dependency, the runtime ships one. The same
// contract as the pg driver, held by `@ultimat3/testing`'s `jobDriverConformance`: every operation
// is one Lua script (`driver-redis-scripts.ts`), so a claim, a settle and a renewal are each atomic
// on the server the way a `driver-pg-sql.ts` statement is in one transaction. Its own entry,
// `@ultimat3/jobs/redis`: the barrel is on every role's boot path, and an app on Postgres loads none
// of this.
//
// Key layout, every key inside ONE hash tag `{<prefix>}` (one slot: legal on Redis Cluster):
//   job:<id>      HASH   the row                    wait:<queue>  ZSET  ready/delayed, by runAt
//   park:<queue>  ZSET   suspended, by runAt        run:<queue>   ZSET  running, by lease end
//   dead:<queue>  ZSET   dead letters, by time      failed:<queue> ZSET failed rows, by time
//   queues        SET    every queue named          idem          HASH  live key → row id
//   steps:<runId> HASH   step name → record JSON    owed          ZSET  onSettled debts, by time

import type { Clock } from '@ultimat3/core';
import { finiteCount, finiteOption, liveClock, uuidV7 } from '@ultimat3/core';
import { redisClient } from '@ultimat3/core/redis';
import { nowMs } from './clock';
import type {
  ClaimedJob,
  EnqueueRequest,
  EnqueueResult,
  JobDriver,
  JobRecord,
  QueueDemand,
  QueueStats,
} from './driver';
import {
  assertClaimBounds,
  assertClaimQueues,
  assertEnqueueMany,
  DEFAULT_QUEUE,
  isJobState,
  nackState,
} from './driver';
import { evalCached } from './driver-redis-eval';
import { typedRefusals } from './driver-redis-refusal';
import {
  REDIS_ACK,
  REDIS_CLAIM,
  REDIS_DEMAND,
  REDIS_ENQUEUE,
  REDIS_ENQUEUE_MANY,
  REDIS_HEARTBEAT,
  REDIS_HOLDS,
  REDIS_NACK,
  REDIS_STATS,
} from './driver-redis-scripts';
import { redisSettleDebt } from './driver-redis-settle';
import { redisStepStore, stepsOf } from './driver-redis-steps';
import { JobDuplicateError } from './errors';
import { MAX_ERROR_STACK_LENGTH } from './introspection';

/** The slice of Bun's Redis client this driver uses — `redisClient()` and `new Bun.RedisClient()`. */
export interface RedisSender {
  send(command: string, args: string[]): Promise<unknown>;
}

/** A finished row's default life: a week, then Redis reclaims it and its steps. */
export const DEFAULT_REDIS_DONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface RedisJobDriverOptions {
  /**
   * Injected in tests and for a second server; production takes `redisClient()` from
   * `@ultimat3/core/redis` (`REDIS_URL`): while it is down every command refuses at once, as
   * `X_DRIVER_UNAVAILABLE`. No deadline here: a stuck command has the request's.
   */
  readonly client?: RedisSender;
  /** Key namespace, the hash tag every key carries. Default `x:jobs`. */
  readonly prefix?: string;
  readonly clock?: Clock;
  /**
   * How long a `done` row (and its steps) outlives its ack, in ms; `0` keeps it forever. Default
   * `DEFAULT_REDIS_DONE_TTL_MS`: a queue in memory that keeps every finished row is a server that
   * runs out of memory. Dead and failed rows are kept — they are the record of what went wrong.
   */
  readonly doneTtlMs?: number;
}

/** A Lua reply as an array; anything else is the empty one. */
const list = (reply: unknown): readonly unknown[] => (Array.isArray(reply) ? reply : []);

/** `HGETALL`'s flat `[field, value, …]` reply as a map. */
function fieldsOf(flat: readonly unknown[]): ReadonlyMap<string, string> {
  const fields = new Map<string, string>();
  for (let i = 0; i + 1 < flat.length; i += 2) fields.set(String(flat[i]), String(flat[i + 1]));
  return fields;
}

const num = (fields: ReadonlyMap<string, string>, name: string): number | undefined => {
  const value = fields.get(name);
  return value === undefined ? undefined : Number(value);
};

/** One stored row as the record every driver hands back. Absent fields stay absent. */
function toRecord(fields: ReadonlyMap<string, string>): JobRecord {
  const state = fields.get('state') ?? '';
  const optional = (name: keyof JobRecord & string) => {
    const value = fields.get(name);
    return value === undefined ? {} : { [name]: value };
  };
  const claim = num(fields, 'claim') ?? 0;
  const visibleAt = num(fields, 'visibleAt');
  return {
    id: fields.get('id') ?? '',
    name: fields.get('name') ?? '',
    queue: fields.get('queue') ?? '',
    input: JSON.parse(fields.get('input') ?? 'null') as unknown,
    idempotencyKey: fields.get('idempotencyKey') ?? '',
    runId: fields.get('runId') ?? '',
    attempt: num(fields, 'attempt') ?? 0,
    maxAttempts: num(fields, 'maxAttempts') ?? 0,
    // A state the list does not know is never cast onto a record: it reads as dead, the one state
    // nothing claims again — the answer `isJobState` gives every driver.
    state: isJobState(state) ? state : 'dead',
    runAt: num(fields, 'runAt') ?? 0,
    createdAt: num(fields, 'createdAt') ?? 0,
    updatedAt: num(fields, 'updatedAt') ?? 0,
    ...optional('tenantId'),
    ...optional('lastError'),
    ...optional('lastErrorStack'),
    ...optional('claimedBy'),
    ...optional('traceparent'),
    ...optional('enqueuedBy'),
    ...(claim > 0 ? { claim } : {}),
    ...(visibleAt === undefined ? {} : { visibleAt }),
  };
}

/**
 * The idempotency namespace field: name, tenant (`''` for none, as the index's `coalesce`) and
 * key, JSON-joined so no separator inside a value can make two triples one field.
 */
const namespaceField = (
  request: Pick<EnqueueRequest, 'name' | 'tenantId' | 'idempotencyKey'>,
): string => JSON.stringify([request.name, request.tenantId ?? '', request.idempotencyKey]);

/** One request as `ENQUEUE_ONE` reads it: `ENQUEUE_ARITY` fields, in its order. */
function enqueueArgs(request: EnqueueRequest, runId: string, at: number): (string | number)[] {
  return [
    request.id ?? uuidV7(),
    request.name,
    request.queue || DEFAULT_QUEUE,
    JSON.stringify(request.input ?? null),
    request.idempotencyKey,
    runId,
    request.maxAttempts,
    request.runAt ?? at,
    at,
    request.tenantId ?? '',
    request.traceparent ?? '',
    request.enqueuedBy ?? '',
    namespaceField(request),
    request.expiresAt ?? '',
    request.onConflict === 'replace' ? '1' : '',
  ];
}

/** The `{ outcome, id, runId }` triple at `at` in a reply, as the result `enqueue` answers. */
function answerOf(reply: readonly unknown[], at: number, runId: string): EnqueueResult {
  const [outcome, id, heldRunId] = reply.slice(at, at + 3).map(String);
  return { id: id ?? '', runId: heldRunId ?? runId, deduped: outcome !== 'created' };
}

export function redisJobDriver(options: RedisJobDriverOptions = {}): JobDriver {
  const client = typedRefusals(options.client ?? redisClient());
  const clock = options.clock ?? liveClock;
  const ns = `{${options.prefix ?? 'x:jobs'}}`;
  const doneTtlMs = finiteCount(
    'redisJobDriver',
    'doneTtlMs',
    options.doneTtlMs ?? DEFAULT_REDIS_DONE_TTL_MS,
  );
  // `KEYS[1]` routes the call to the namespace's slot; every key a script builds is in it.
  const run = (script: string, args: readonly (string | number)[]): Promise<unknown> =>
    evalCached(client, script, ['1', `${ns}:queues`, ns, ...args.map(String)]);

  return {
    name: 'redis',
    steps: redisStepStore({ ns, run, client }),
    settleDebt: redisSettleDebt({ run, clock, record: (flat) => toRecord(fieldsOf(flat)) }),

    // `wait:<queue>` IS the ready and delayed rows of the queue: one `ZCARD`, capped here.
    async backlog(queue, cap): Promise<number> {
      const limit = finiteCount('the redis driver backlog', 'cap', cap);
      return Math.min(Number(await client.send('ZCARD', [`${ns}:wait:${queue}`])), limit);
    },

    // Only a full `maxPending` asks: a live holder means the enqueue adds no row.
    async holds(name, idempotencyKey, tenantId): Promise<boolean> {
      const field = namespaceField({
        name,
        idempotencyKey,
        ...(tenantId === undefined ? {} : { tenantId }),
      });
      return Number(await run(REDIS_HOLDS, [field])) === 1;
    },

    async enqueue(request): Promise<EnqueueResult> {
      const runId = request.runId ?? uuidV7();
      const reply = list(await run(REDIS_ENQUEUE, enqueueArgs(request, runId, nowMs(clock))));
      const answer = answerOf(reply, 0, runId);
      if (reply[0] === 'deduped' && request.onConflict === 'error') {
        throw new JobDuplicateError({
          job: request.name,
          idempotencyKey: request.idempotencyKey,
          existingId: answer.id,
        });
      }
      return answer;
    },

    // ONE script for the batch (`REDIS_ENQUEUE_MANY`), the body `enqueue` runs once per request:
    // atomic on the server, and a key twice in it meets its own first request.
    async enqueueMany(requests): Promise<readonly EnqueueResult[]> {
      assertEnqueueMany('redis', requests);
      if (requests.length === 0) return [];
      const at = nowMs(clock);
      const runIds = requests.map((request) => request.runId ?? uuidV7());
      const args = requests.flatMap((request, index) =>
        enqueueArgs(request, runIds[index] ?? uuidV7(), at),
      );
      const reply = list(await run(REDIS_ENQUEUE_MANY, args));
      return runIds.map((runId, index) => answerOf(reply, index * 3, runId));
    },

    async claim(claimOptions): Promise<readonly ClaimedJob[]> {
      assertClaimQueues('redis', claimOptions);
      assertClaimBounds('redis', claimOptions);
      const drop = claimOptions.dropExhausted ?? [];
      const reply = await run(REDIS_CLAIM, [
        nowMs(clock),
        claimOptions.limit,
        claimOptions.visibilityTimeoutMs,
        claimOptions.workerId,
        claimOptions.onEmpty === undefined ? '0' : '1',
        drop.length,
        ...drop,
        ...claimOptions.queues,
      ]);
      const claimed: ClaimedJob[] = [];
      const buried: JobRecord[] = [];
      for (const entry of list(reply)) {
        const [kind, flat, steps] = list(entry);
        if (kind === 'h') {
          claimOptions.onEmpty?.(flat === undefined || flat === null ? null : Number(flat));
          continue;
        }
        const fields = fieldsOf(list(flat));
        const record = toRecord(fields);
        if (kind === 'b') {
          buried.push(record);
          continue;
        }
        claimed.push({
          ...record,
          claimedBy: claimOptions.workerId,
          claim: record.claim ?? 1,
          claimedAt: num(fields, 'claimedAt') ?? 0,
          visibleAt: record.visibleAt ?? 0,
          steps: stepsOf(list(steps)),
        });
      }
      if (buried.length > 0) claimOptions.onExhausted?.(buried);
      return claimed;
    },

    async ack(jobId, by): Promise<boolean> {
      const owes = by.owesSettle === true ? '1' : '0';
      const reply = await run(REDIS_ACK, [
        jobId,
        by.workerId,
        by.claim,
        nowMs(clock),
        doneTtlMs,
        owes,
      ]);
      return Number(reply) === 1;
    },

    async nack(jobId, nackOptions): Promise<boolean> {
      finiteOption('the redis driver nack', 'delayMs', nackOptions.delayMs);
      const at = nowMs(clock);
      const error = nackOptions.error;
      const reply = await run(REDIS_NACK, [
        jobId,
        nackOptions.workerId,
        nackOptions.claim,
        at,
        nackState(nackOptions),
        at + nackOptions.delayMs,
        nackOptions.countsAsAttempt === false ? '0' : '1',
        error === undefined ? '0' : '1',
        error ?? '',
        error === undefined ? '' : (nackOptions.stack ?? '').slice(0, MAX_ERROR_STACK_LENGTH),
        nackOptions.owesSettle === true ? '1' : '0',
      ]);
      return Number(reply) === 1;
    },

    async heartbeat(jobId, heartbeatOptions): Promise<boolean> {
      finiteOption(
        'the redis driver heartbeat',
        'visibilityTimeoutMs',
        heartbeatOptions.visibilityTimeoutMs,
      );
      const reply = await run(REDIS_HEARTBEAT, [
        jobId,
        heartbeatOptions.workerId ?? '',
        heartbeatOptions.claim === undefined ? '' : heartbeatOptions.claim,
        nowMs(clock) + heartbeatOptions.visibilityTimeoutMs,
      ]);
      return Number(reply) === 1;
    },

    async stats(): Promise<readonly QueueStats[]> {
      const at = nowMs(clock);
      const rows = list(await run(REDIS_STATS, [at])).map((row): QueueStats => {
        const [queue, ready, delayed, running, suspended, failed, dead, oldest] = list(row);
        const first = Number(oldest);
        return {
          queue: String(queue),
          ready: Number(ready),
          delayed: Number(delayed),
          running: Number(running),
          suspended: Number(suspended),
          failed: Number(failed),
          dead: Number(dead),
          oldestReadyMs: first < 0 ? 0 : at - first,
        };
      });
      // Code units, as `collate "C"` orders `SQL_STATS` — never `localeCompare`.
      return rows.sort((a, b) => (a.queue < b.queue ? -1 : a.queue > b.queue ? 1 : 0));
    },

    async demand(): Promise<readonly QueueDemand[]> {
      const rows = list(await run(REDIS_DEMAND, [nowMs(clock)])).map((row): QueueDemand => {
        const [queue, demand] = list(row);
        return { queue: String(queue), demand: Number(demand) };
      });
      return rows.sort((a, b) => (a.queue < b.queue ? -1 : a.queue > b.queue ? 1 : 0));
    },
  };
}
