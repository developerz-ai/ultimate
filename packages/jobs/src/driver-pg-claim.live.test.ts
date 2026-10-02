// The claim's burial and the enqueue's retry against a real server, CONCURRENTLY — what the
// embedded database cannot show: it runs one statement at a time. Eight sessions claiming at once
// must bury each poison row exactly once (`for update skip locked` over both arms), and an enqueue
// racing its key's holder settling must answer, never refuse. Skips unless `TEST_DATABASE_URL`.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { PostgresClient } from '@ultimat3/db';
import { createPostgresClient, raw } from '@ultimat3/db';
import type { JobDriver, JobRecord } from './driver';
import { LEASE_LAPSED_FINAL_ATTEMPT } from './driver';
import type { PgExecutor } from './driver-pg';
import { createPgDriver } from './driver-pg';
import { SQL_JOBS_TABLE } from './driver-pg-sql';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const PROBE_DB = 'x_jobs_claim_live';
const SESSIONS = 8;
const TTL_MS = 30_000;

const probeUrl = (): string => {
  const parsed = new URL(url ?? 'postgres://localhost/postgres');
  parsed.pathname = `/${PROBE_DB}`;
  return parsed.toString();
};

/** `count` rows a worker died holding: `running`, lease lapsed, `attempt` of `max` spent. */
const ORPHANS = `
insert into x_jobs
  (id, name, queue, input, idempotency_key, run_id, attempt, max_attempts, state, claims,
   claimed_by, visible_at)
select gen_random_uuid(), $1, 'default', '{}'::jsonb, $1 || ':' || g, gen_random_uuid(),
       $2::int, $3::int, 'running', $2::int, 'worker-gone', now() - interval '1 second'
  from generate_series(1, $4::int) as g
`;

describe.skipIf(!hasPostgres)('live · postgres · the claim buries a poison row once', () => {
  let admin: PostgresClient;
  let client: PostgresClient;
  let executor: PgExecutor;
  let driver: JobDriver;

  beforeAll(async () => {
    admin = createPostgresClient({ url: url ?? '', role: 'web', profile: { max: 1 } });
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await admin.execute(raw(`create database ${PROBE_DB}`));
    client = createPostgresClient({ url: probeUrl(), role: 'web', profile: { max: SESSIONS } });
    for (const statement of SQL_JOBS_TABLE.split(';')) {
      if (statement.trim().length > 0) await client.execute(raw(statement));
    }
    executor = {
      query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
        client.query<R>({ text, values }),
    };
    driver = createPgDriver({ executor });
  });

  beforeEach(async () => {
    await executor.query('delete from x_jobs', []);
    await executor.query('delete from x_job_counters', []);
  });

  afterAll(async () => {
    await client.close();
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await admin.close();
  });

  const pass = async (
    workerId: string,
    limit: number,
  ): Promise<{ readonly claimed: readonly string[]; readonly buried: readonly JobRecord[] }> => {
    const buried: JobRecord[] = [];
    const claimed = await driver.claim({
      queues: ['default'],
      limit,
      visibilityTimeoutMs: TTL_MS,
      workerId,
      onExhausted: (dead) => {
        buried.push(...dead);
      },
    });
    return { claimed: claimed.map((row) => row.id), buried };
  };

  test('eight workers claiming at once bury every exhausted row exactly once and claim the rest', async () => {
    await executor.query(ORPHANS, ['poison', 3, 3, 40]);
    await executor.query(ORPHANS, ['redeliver', 1, 3, 40]);

    const passes: { claimed: readonly string[]; buried: readonly JobRecord[] }[] = [];
    // Rounds until a whole round finds nothing: `skip locked` lets a pass come back short.
    for (let round = 0; round < 20; round += 1) {
      const results = await Promise.all(
        Array.from({ length: SESSIONS }, (_, index) => pass(`worker-${index}`, 7)),
      );
      passes.push(...results);
      if (results.every((result) => result.claimed.length + result.buried.length === 0)) break;
    }

    const buried = passes.flatMap((result) => result.buried);
    const claimed = passes.flatMap((result) => result.claimed);
    // Reported ONCE each: a row two passes both reported is an `onSettled` that fires twice.
    expect(buried).toHaveLength(40);
    expect(new Set(buried.map((row) => row.id)).size).toBe(40);
    expect(buried.every((row) => row.name === 'poison' && row.state === 'dead')).toBe(true);
    expect(buried.every((row) => row.lastError === LEASE_LAPSED_FINAL_ATTEMPT)).toBe(true);
    expect(claimed).toHaveLength(40);
    expect(new Set(claimed).size).toBe(40);

    const states = await executor.query<{
      name: string;
      state: string;
      attempt: number;
      n: number;
    }>(
      `select name, state, attempt, count(*)::int as n from x_jobs
        group by name, state, attempt order by name`,
      [],
    );
    expect(states).toEqual([
      { name: 'poison', state: 'dead', attempt: 3, n: 40 },
      { name: 'redeliver', state: 'running', attempt: 2, n: 40 },
    ]);
    // Counted once each too, however the forty were split between passes and upserts.
    const counted = await executor.query<{ job: string; dead: number }>(
      'select job, sum(dead)::int as dead from x_job_counters group by job',
      [],
    );
    expect(counted).toEqual([{ job: 'poison', dead: 40 }]);
    expect((await driver.introspect?.deadLetters(100))?.length).toBe(40);
  });

  test('an enqueue racing its key holder settling answers every time — deduped or a new row', async () => {
    const outcomes = { deduped: 0, inserted: 0 };
    for (let round = 0; round < 60; round += 1) {
      const request = {
        name: 'racer',
        queue: 'default',
        input: {},
        idempotencyKey: `racer:${round}`,
        maxAttempts: 3,
      };
      const holder = await driver.enqueue(request);
      const [claimed] = await driver.claim({
        queues: ['default'],
        limit: 1,
        visibilityTimeoutMs: TTL_MS,
        workerId: 'holder',
      });
      expect(claimed?.id).toBe(holder.id);
      // The holder acks while four callers enqueue its key. Whichever side of the ack each insert
      // and each lookup lands on, the answer is an id — never `X_DRIVER_UNAVAILABLE`.
      const [acked, answers] = await Promise.all([
        driver.ack(holder.id, { workerId: 'holder', claim: claimed?.claim ?? 0 }),
        Promise.all(Array.from({ length: 4 }, () => driver.enqueue(request))),
      ]);
      expect(acked).toBe(true);
      for (const answer of answers) {
        if (answer.deduped) outcomes.deduped += 1;
        else outcomes.inserted += 1;
      }
      // At most one live row of the key, whatever the interleaving.
      const live = await executor.query<{ n: number }>(
        `select count(*)::int as n from x_jobs
          where idempotency_key = $1 and state in ('ready', 'delayed', 'running', 'suspended')`,
        [request.idempotencyKey],
      );
      expect(live[0]?.n).toBeLessThanOrEqual(1);
      await executor.query(`update x_jobs set state = 'done' where idempotency_key = $1`, [
        request.idempotencyKey,
      ]);
    }
    expect(outcomes.deduped + outcomes.inserted).toBe(240);
  });
});
