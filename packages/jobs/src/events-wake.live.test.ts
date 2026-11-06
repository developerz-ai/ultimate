// A published event wakes its waiter, against a real server on a pooled client: the probe's five
// rows, a rollback undoing event and wake together, the NOTIFY delivered at commit and never on a
// miss, and two concurrent publishes for one waiter. Skips unless `TEST_DATABASE_URL` is set.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { probeDatabaseName, sweepProbeDatabases, uuidV7 } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import { dbExecutor, postgresClient, raw } from '@ultimat3/db';
import { SQL_EVENT_PUBLISH_WAKE } from './driver-pg-event-wake-sql';
import { SQL_JOBS_TABLE } from './driver-pg-sql';
import { JOBS_WAKE_CHANNEL } from './driver-pg-wake-sql';
import { postgresEventBus } from './events-pg';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const PROBE_DB = probeDatabaseName('x_jobs_events_wake_live');
const PARKED_FOR = `interval '1 hour'`;

const probeUrl = (): string => {
  const parsed = new URL(url ?? 'postgres://localhost/postgres');
  parsed.pathname = `/${PROBE_DB}`;
  return parsed.toString();
};

interface Waiter {
  readonly label: string;
  readonly queue: string;
  readonly event: string;
  readonly key: string | null;
  readonly state: 'suspended' | 'running';
}

/** The probe's five rows: a matching key, another key, a keyless wait, another event, a running row. */
const PROBE: readonly Waiter[] = [
  { label: 'k', queue: 'billing', event: 'invoice.paid', key: 'inv-1', state: 'suspended' },
  { label: 'other', queue: 'billing', event: 'invoice.paid', key: 'inv-2', state: 'suspended' },
  { label: 'anyKey', queue: 'billing', event: 'invoice.paid', key: null, state: 'suspended' },
  { label: 'otherEvent', queue: 'mail', event: 'invoice.void', key: 'inv-1', state: 'suspended' },
  { label: 'running', queue: 'mail', event: 'invoice.paid', key: 'inv-1', state: 'running' },
];

describe.skipIf(!hasPostgres)('live · postgres · a published event wakes its waiter', () => {
  let admin: PostgresClient;
  let client: PostgresClient;
  let executor: PgExecutor;

  beforeAll(async () => {
    admin = postgresClient({ url: url ?? '', role: 'web', profile: { max: 1 } });
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await sweepProbeDatabases(
      dbExecutor(() => admin),
      PROBE_DB,
    );
    await admin.execute(raw(`create database ${PROBE_DB}`));
    client = postgresClient({ url: probeUrl(), role: 'worker', profile: { max: 4 } });
    for (const statement of SQL_JOBS_TABLE.split(';')) {
      if (statement.trim().length > 0) await client.execute(raw(statement));
    }
    executor = dbExecutor(() => client);
  });

  beforeEach(async () => {
    await executor.query('truncate x_jobs, x_job_steps, x_job_events', []);
  });

  afterAll(async () => {
    await client.close();
    await admin.execute(raw(`drop database if exists ${PROBE_DB} with (force)`));
    await admin.close();
  });

  /** One parked run per waiter, due an hour from now, and its `waiting` step. */
  async function park(waiters: readonly Waiter[]): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    for (const waiter of waiters) {
      const id = uuidV7();
      const runId = uuidV7();
      ids.set(waiter.label, id);
      await executor.query(
        `insert into x_jobs (id, name, queue, input, idempotency_key, run_id, state, run_at)
         values ($1::uuid, 'approve', $2, '{}'::jsonb, $1::text, $3, $4, now() + ${PARKED_FOR})`,
        [id, waiter.queue, runId, waiter.state],
      );
      await executor.query(
        `insert into x_job_steps (run_id, name, status, event, correlation_key, wake_at)
         values ($1, 'wait', 'waiting', $2, $3, now() + ${PARKED_FOR})`,
        [runId, waiter.event, waiter.key],
      );
    }
    return ids;
  }

  /** Which of `ids` are due now — the claim's own predicate on `run_at`. */
  async function due(ids: Map<string, string>): Promise<Record<string, boolean>> {
    const out: Record<string, boolean> = {};
    for (const [label, id] of ids) {
      const rows = await executor.query<{ due: boolean }>(
        'select run_at <= now() as due from x_jobs where id = $1',
        [id],
      );
      out[label] = rows[0]?.due === true;
    }
    return out;
  }

  test('a matching key and a keyless wait wake; another key, another event and a running row do not', async () => {
    const ids = await park(PROBE);
    const bus = postgresEventBus({ executor, wakes: true });
    expect(bus.wakes).toBe(true);
    await bus.publish('invoice.paid', { amount: 12 }, { correlationKey: 'inv-1' });
    expect(await due(ids)).toEqual({
      k: true,
      other: false,
      anyKey: true,
      otherEvent: false,
      running: false,
    });
  });

  test('a bus built without wakes publishes and wakes nobody', async () => {
    const ids = await park(PROBE.slice(0, 1));
    const bus = postgresEventBus({ executor });
    expect(bus.wakes).toBe(false);
    await bus.publish('invoice.paid', { amount: 12 }, { correlationKey: 'inv-1' });
    expect(await due(ids)).toEqual({ k: false });
  });

  test('a rollback undoes the event and the wake together', async () => {
    const ids = await park(PROBE.slice(0, 1));
    using connection = await client.reserve();
    const tx: PgExecutor = {
      query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
        connection.query<R>({ text, values }),
    };
    await tx.query('begin', []);
    await postgresEventBus({ executor: tx, wakes: true }).publish(
      'invoice.paid',
      { amount: 12 },
      { correlationKey: 'inv-1' },
    );
    const inside = await tx.query<{ due: boolean }>(
      "select run_at <= now() + interval '1 second' as due from x_jobs where id = $1",
      [ids.get('k')],
    );
    expect(inside[0]?.due).toBe(true);
    await tx.query('rollback', []);
    expect(await due(ids)).toEqual({ k: false });
    const events = await executor.query<{ n: number }>(
      'select count(*)::int as n from x_job_events',
      [],
    );
    expect(events[0]?.n).toBe(0);
  });

  test('the queue is told at commit, once per queue, and never on a publish that woke nobody', async () => {
    await park([
      PROBE[0] as Waiter,
      { ...(PROBE[2] as Waiter), label: 'second' },
      { ...(PROBE[0] as Waiter), label: 'mailWaiter', queue: 'mail' },
    ]);
    const heard: string[] = [];
    let listening!: () => void;
    const ready = new Promise<void>((resolve) => {
      listening = resolve;
    });
    const subscription = await client.listen(
      JOBS_WAKE_CHANNEL,
      (payload) => heard.push(payload),
      () => listening(),
    );
    try {
      await ready;
      const bus = postgresEventBus({ executor, wakes: true });
      // Nobody waits on this event: no notification at all.
      await bus.publish('order.shipped', {}, { correlationKey: 'inv-1' });
      using connection = await client.reserve();
      const tx: PgExecutor = {
        query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
          connection.query<R>({ text, values }),
      };
      await tx.query('begin', []);
      await postgresEventBus({ executor: tx, wakes: true }).publish(
        'invoice.paid',
        {},
        { correlationKey: 'inv-1' },
      );
      // real-clock: a NOTIFY is delivered by the Postgres server, so silence is waited for
      await Bun.sleep(150);
      expect(heard).toEqual([]);
      await tx.query('commit', []);
      const deadline = performance.now() + 5_000;
      // real-clock: notifications arrive from the Postgres server's own process
      while (heard.length < 2 && performance.now() < deadline) await Bun.sleep(10);
      // real-clock: a third, unwanted notification would arrive from the server, if at all
      await Bun.sleep(100);
      // Three runs woken on two queues: two notifications, one per queue.
      expect([...heard].sort()).toEqual(['billing', 'mail']);
    } finally {
      await subscription.unlisten();
    }
  });

  test('two concurrent publishes for one waiter both land, and the row is woken once', async () => {
    const ids = await park(PROBE.slice(0, 1));
    using first = await client.reserve();
    using second = await client.reserve();
    const on = (connection: typeof first): PgExecutor => ({
      query: <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
        connection.query<R>({ text, values }),
    });
    const a = on(first);
    const b = on(second);
    // The statement itself, so its `woken` column can be read: the bus answers the event only.
    const publish = async (tx: PgExecutor, n: number): Promise<number> => {
      const rows = await tx.query<{ woken: number }>(SQL_EVENT_PUBLISH_WAKE, [
        uuidV7(),
        'invoice.paid',
        JSON.stringify({ n }),
        'inv-1',
        60_000,
      ]);
      return rows[0]?.woken ?? -1;
    };
    await a.query('begin', []);
    await b.query('begin', []);
    expect(await publish(a, 1)).toBe(1);
    // The second blocks on the row the first holds, then re-checks `run_at` after its commit.
    const late = publish(b, 2);
    // real-clock: session b blocks inside the Postgres server until a commits
    await Bun.sleep(100);
    await a.query('commit', []);
    expect(await late).toBe(0);
    await b.query('commit', []);
    const events = await executor.query<{ n: number }>(
      'select count(*)::int as n from x_job_events',
      [],
    );
    expect(events[0]?.n).toBe(2);
    expect(await due(ids)).toEqual({ k: true });
  });
});
