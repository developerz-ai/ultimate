// The Redis driver against a real server, beyond `@ultimat3/testing`'s conformance suite: one
// script of queue operations run on the memory driver and on Redis under the same frozen clock
// must answer the same, step for step — and eight claimers racing one queue hand every row out
// exactly once. Skips unless `TEST_REDIS_URL`.

import { afterAll, describe, expect, test } from 'bun:test';
import type { FrozenClock } from '@ultimat3/core';
import { frozenClock } from '@ultimat3/core';
import { redisClient } from '@ultimat3/core/redis';
import type { JobDriver, StepStore } from '.';
import { isJobState } from './driver';
import { driverEnqueueManyScenarios } from './driver-enqueue-many-fixture';
import { memoryJobDriver } from './driver-memory';
import { redisJobDriver } from './driver-redis';
import { DriverUnavailableError } from './errors';

const url = Bun.env['TEST_REDIS_URL'] ?? '';
const prefix = `xlive-jobs-${crypto.randomUUID()}`;

/** What a driver answered, minus the ids and run ids it minted. */
const shapeOf = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (key, inner: unknown) =>
      key === 'id' || key === 'runId' || key === 'existingId' ? '<minted>' : inner,
    ),
  );

/** A refusal, as the one thing two drivers must agree on: its code. */
const codeOf = (error: unknown): unknown => ({ code: (error as { code?: unknown }).code });

/** The same operations, in the same order, on any driver. Answers everything each step said. */
async function script(driver: JobDriver, clock: FrozenClock, queue: string): Promise<unknown[]> {
  const said: unknown[] = [];
  const enqueue = (key: string, extra: object = {}) =>
    driver.enqueue({
      name: 'parity.job',
      queue,
      input: { key },
      idempotencyKey: key,
      maxAttempts: 2,
      ...extra,
    });
  const first = await enqueue('a');
  said.push(first, await enqueue('a'));
  said.push(await enqueue('later', { runAt: clock.now().getTime() + 60_000, tenantId: 'org-1' }));
  said.push(await enqueue('a', { onConflict: 'error' }).catch(codeOf));
  said.push(await driver.stats(), await driver.demand());

  clock.advance(1_000);
  const [claimed] = await driver.claim({
    queues: [queue],
    limit: 5,
    visibilityTimeoutMs: 500,
    workerId: 'w',
  });
  said.push(claimed);
  const by = { workerId: 'w', claim: claimed?.claim ?? -1 };
  said.push(await driver.heartbeat(first.id, { visibilityTimeoutMs: 2_000, ...by }));
  // A suspension: parked, the attempt handed back.
  said.push(
    await driver.nack(first.id, { ...by, delayMs: 5_000, countsAsAttempt: false, park: true }),
  );
  said.push(await driver.stats(), await driver.demand());

  clock.advance(5_000);
  const [again] = await driver.claim({
    queues: [queue],
    limit: 5,
    visibilityTimeoutMs: 500,
    workerId: 'w',
  });
  said.push(again);
  const byAgain = { workerId: 'w', claim: again?.claim ?? -1 };
  said.push(await driver.nack(first.id, { ...byAgain, delayMs: 0, error: 'boom', stack: 'at x' }));
  said.push(await driver.stats(), await driver.demand());

  clock.advance(100_000);
  const both = await driver.claim({
    queues: [queue],
    limit: 5,
    visibilityTimeoutMs: 500,
    workerId: 'w',
  });
  said.push(both);
  for (const row of both) {
    said.push(await driver.ack(row.id, { workerId: 'w', claim: row.claim }));
  }
  said.push(await driver.stats(), await enqueue('a'));
  return said;
}

/** `demand()` over every row it counts: running, due waiting, due parked; a future row is out. */
async function demand(driver: JobDriver, clock: FrozenClock, queue: string): Promise<unknown[]> {
  const at = clock.now().getTime();
  for (const [key, runAt] of [
    ['run', at],
    ['park', at],
    ['due', at],
    ['later', at + 60_000],
  ] as const) {
    await driver.enqueue({
      name: 'demand.job',
      queue,
      input: {},
      idempotencyKey: key,
      maxAttempts: 3,
      runAt,
    });
  }
  const claimed = await driver.claim({
    queues: [queue],
    limit: 2,
    visibilityTimeoutMs: 60_000,
    workerId: 'w',
  });
  const parked = claimed[1];
  if (parked === undefined) return expect.unreachable('two rows were claimed');
  await driver.nack(parked.id, {
    workerId: 'w',
    claim: parked.claim,
    delayMs: 1_000,
    countsAsAttempt: false,
    park: true,
  });
  const said: unknown[] = [await driver.demand()];
  clock.advance(1_000);
  said.push(await driver.demand());
  return said;
}

/** A step store's whole contract, fenced and not, as the answers it gave. */
async function steps(driver: JobDriver, queue: string): Promise<unknown[]> {
  const store: StepStore = driver.steps;
  const { id, runId } = await driver.enqueue({
    name: 'parity.steps',
    queue,
    input: {},
    idempotencyKey: 'steps',
    maxAttempts: 1,
  });
  const [claimed] = await driver.claim({
    queues: [queue],
    limit: 1,
    visibilityTimeoutMs: 60_000,
    workerId: 'w',
  });
  const fence = { job: 'parity.steps', jobId: id, workerId: 'w', claim: claimed?.claim ?? -1 };
  const record = (name: string, startedAt: number) => ({
    runId,
    name,
    status: 'completed' as const,
    output: { at: new Date(0) },
    startedAt,
    attempts: 1,
  });
  await store.put(record('second', 2), fence);
  await store.put(record('first', 1));
  const said: unknown[] = [await store.get(runId, 'second'), await store.list(runId)];
  said.push(
    await store.put(record('third', 3), { ...fence, claim: fence.claim + 1 }).catch(codeOf),
  );
  await store.del(runId, 'first');
  said.push(await store.list(runId));
  await store.clear(runId);
  said.push(await store.list(runId), await store.get(runId, 'second'));
  return said;
}

describe.skipIf(url === '')('live · redis · the job driver', () => {
  const client = url === '' ? undefined : new Bun.RedisClient(url);
  const on = { prefix, ...(client === undefined ? {} : { client }) };
  const redisOn = (clock?: FrozenClock) =>
    redisJobDriver({ ...on, ...(clock === undefined ? {} : { clock }) });

  afterAll(async () => {
    if (client === undefined) return;
    // `{prefix*`: the batch scenarios' own namespaces too, each `<prefix>-many-<uuid>`.
    const found: unknown = await client.send('KEYS', [`{${prefix}*`]);
    for (const key of Array.isArray(found) ? found : []) await client.send('DEL', [String(key)]);
    client.close();
  });

  // The batch scenarios every driver answers (`driver-enqueue-many-fixture.ts`), each on a fresh
  // namespace. Redis has no `introspect`, so a row is read off its own HASH.
  describe('enqueueMany, as memory and Postgres answer it', () => {
    const prefixes = new WeakMap<JobDriver, string>();
    // `HGETALL` through `Bun.RedisClient` answers an OBJECT (RESP3 map), not the flat field/value
    // list a Lua script returns — reading it as a list read every row as absent.
    const field = (reply: unknown, name: string): string | undefined => {
      if (typeof reply !== 'object' || reply === null || Array.isArray(reply)) return undefined;
      const value: unknown = Object.getOwnPropertyDescriptor(reply, name)?.value;
      return value === undefined ? undefined : String(value);
    };
    driverEnqueueManyScenarios('redis', {
      fresh: () => {
        const own = `${prefix}-many-${crypto.randomUUID()}`;
        const driver = redisJobDriver({ ...on, prefix: own });
        prefixes.set(driver, own);
        return Promise.resolve(driver);
      },
      now: () => Promise.resolve(Date.now()),
      row: async (driver, id) => {
        const flat = await client?.send('HGETALL', [`{${prefixes.get(driver)}}:job:${id}`]);
        const state = field(flat, 'state');
        if (state === undefined || !isJobState(state)) return undefined;
        return {
          input: JSON.parse(field(flat, 'input') ?? 'null') as unknown,
          state,
          runAt: Number(field(flat, 'runAt')),
        };
      },
      count: async (driver) => {
        const found = await client?.send('KEYS', [`{${prefixes.get(driver)}}:job:*`]);
        return Array.isArray(found) ? found.length : Number.NaN;
      },
    });
  });

  test('answers every queue operation as the memory driver does', async () => {
    const at = '2026-10-01T00:00:00.000Z';
    const memoryClock = frozenClock(at);
    const redisClock = frozenClock(at);
    const expected = await script(memoryJobDriver({ clock: memoryClock }), memoryClock, 'parity');
    const actual = await script(redisOn(redisClock), redisClock, 'parity');
    expect(shapeOf(actual)).toEqual(shapeOf(expected));
  });

  test('counts demand as the memory driver does: running, due, and a parked run once due', async () => {
    const at = '2026-10-01T00:00:00.000Z';
    const memoryClock = frozenClock(at);
    const redisClock = frozenClock(at);
    const expected = await demand(memoryJobDriver({ clock: memoryClock }), memoryClock, 'demand');
    const actual = await demand(redisOn(redisClock), redisClock, 'demand');
    expect(actual).toEqual(expected);
    expect(actual).toEqual([[{ queue: 'demand', demand: 2 }], [{ queue: 'demand', demand: 3 }]]);
  });

  test('keeps steps as the memory driver does, and fences a write on the claim', async () => {
    const expected = await steps(memoryJobDriver(), 'parity-steps');
    const actual = await steps(redisOn(), 'parity-steps');
    expect(shapeOf(actual)).toEqual(shapeOf(expected));
    expect(actual[2]).toMatchObject({ code: 'X_JOB_LEASE_LOST' });
  });

  test('eight claimers racing one queue hand every row out exactly once', async () => {
    const driver = redisOn();
    const rows = 40;
    for (let index = 0; index < rows; index += 1) {
      await driver.enqueue({
        name: 'race.job',
        queue: 'race',
        input: {},
        idempotencyKey: `r${index}`,
        maxAttempts: 3,
      });
    }
    const claims = await Promise.all(
      Array.from({ length: 8 }, (_, worker) =>
        driver.claim({
          queues: ['race'],
          limit: 10,
          visibilityTimeoutMs: 60_000,
          workerId: `w${worker}`,
        }),
      ),
    );
    const ids = claims.flat().map((row) => row.id);
    expect(ids).toHaveLength(rows);
    expect(new Set(ids).size).toBe(rows);
  });

  test('a done row expires with its steps; a dead one is kept', async () => {
    const driver = redisJobDriver({ ...on, doneTtlMs: 60_000 });
    const enqueue = (key: string) =>
      driver.enqueue({
        name: 'ttl.job',
        queue: 'ttl',
        input: {},
        idempotencyKey: key,
        maxAttempts: 1,
      });
    const done = await enqueue('done');
    const dead = await enqueue('dead');
    const claimed = await driver.claim({
      queues: ['ttl'],
      limit: 2,
      visibilityTimeoutMs: 60_000,
      workerId: 'w',
    });
    for (const row of claimed) {
      const by = { workerId: 'w', claim: row.claim };
      if (row.id === done.id) await driver.ack(row.id, by);
      else await driver.nack(row.id, { ...by, delayMs: 0, deadLetter: true });
    }
    const ttl = async (id: string) => Number(await client?.send('PTTL', [`{${prefix}}:job:${id}`]));
    expect(await ttl(done.id)).toBeGreaterThan(0);
    expect(await ttl(dead.id)).toBe(-1);
  });

  test('a killed connection: enqueue is X_DRIVER_UNAVAILABLE at once, then the queue answers', async () => {
    /** Ask until `ready()` holds, or fail after `limitMs` of the server's and Bun's own time. */
    const until = async (ready: () => Promise<boolean> | boolean, limitMs: number) => {
      const started = performance.now();
      while (!(await ready())) {
        if (performance.now() - started > limitMs) expect.unreachable(`not ready in ${limitMs} ms`);
        // real-clock: Bun's reconnect loop and the server's socket close run on their own timers.
        await Bun.sleep(10);
      }
    };
    // core's client, the one the driver takes when none is handed in, on a path of its own.
    const own = redisClient(`${url}/2`);
    try {
      const driver = redisJobDriver({ client: own, prefix: `${prefix}-outage` });
      const request = { name: 'outage.job', input: null, idempotencyKey: 'k', maxAttempts: 1 };
      await until(() => own.connected, 2_000);
      const id = String((await own.send('CLIENT', ['ID'])) as unknown);
      expect(Number((await client?.send('CLIENT', ['KILL', 'ID', id])) as unknown)).toBe(1);
      await until(() => !own.connected, 2_000);

      const started = performance.now();
      const refusal = await driver.enqueue({ ...request, queue: 'outage' }).then(
        () => expect.unreachable('an enqueue on a killed connection answered'),
        (error: unknown) => error,
      );
      expect(performance.now() - started).toBeLessThan(50);
      expect(refusal).toBeInstanceOf(DriverUnavailableError);

      await until(
        () =>
          driver.enqueue({ ...request, queue: 'outage' }).then(
            () => true,
            () => false,
          ),
        5_000,
      );
      const found: unknown = await own.send('KEYS', [`{${prefix}-outage}*`]);
      for (const key of Array.isArray(found) ? found : []) await own.send('DEL', [String(key)]);
    } finally {
      own.close();
    }
  });
});
