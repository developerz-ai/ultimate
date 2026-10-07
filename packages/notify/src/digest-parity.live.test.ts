// One suite, two digest stores: every window rule `memoryDigestStore` answers, the Postgres
// store answers the same way against a real server — plus the two things only a database can
// prove: a window outlives the store that opened it, and two concurrent openers make ONE window.
// The Postgres half needs `TEST_DATABASE_URL`; it makes its own database and drops it.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import { type DigestSlot, type DigestStore, memoryDigestStore } from './digest';
import { postgresDigestStore, SQL_NOTIFY_DIGESTS_TABLE } from './digest-pg';
import type { NotifyEvent } from './notification';

const url = Bun.env['TEST_DATABASE_URL'];
const PROBE_DB = 'x_notify_digest_probe';

const slot: DigestSlot = {
  recipient: 'ana',
  notifier: 'post.commented',
  channel: 'email',
  group: 'g',
};
const event = (key: string, at = 0): NotifyEvent<unknown> => ({
  notifier: 'post.commented',
  key,
  params: { key },
  at: new Date(at),
});
const keys = (events: readonly NotifyEvent<unknown>[]): readonly string[] =>
  events.map((one) => one.key);
/** One run per event key unless a test names the run: a replay is the SAME appender again. */
const append = (
  store: DigestStore,
  key: string,
  now: number,
  on: DigestSlot = slot,
  appender = `run-${key}`,
) =>
  store.append({ slot: on, event: event(key, now), windowMs: 100, now: new Date(now), appender });

type Sql = InstanceType<typeof Bun.SQL>;
let sql: Sql | undefined;

const admin = async (statement: string): Promise<void> => {
  const client = new Bun.SQL(url ?? '', { max: 1 });
  try {
    await client.unsafe(statement, []);
  } finally {
    await client.end();
  }
};

/**
 * `Bun.SQL` over `unsafe` binds a `Date` by `toString()`, which Postgres cannot parse; the boot's
 * executor (`@ultimat3/db`'s client) binds it as an instant, and this package depends on no driver.
 */
const bound = (value: unknown): unknown => (value instanceof Date ? value.toISOString() : value);

const executor = (): PgExecutor => ({
  query: async <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> => {
    if (sql === undefined) return expect.unreachable('beforeAll opened no database');
    return [...(await sql.unsafe(text, values.map(bound)))] as R[];
  },
});

beforeAll(async () => {
  if (url === undefined) return;
  await admin(`drop database if exists ${PROBE_DB} with (force)`);
  await admin(`create database ${PROBE_DB}`);
  const target = new URL(url);
  target.pathname = `/${PROBE_DB}`;
  sql = new Bun.SQL(target.href, { max: 4, prepare: false });
  for (const statement of SQL_NOTIFY_DIGESTS_TABLE.split(';')) {
    if (statement.trim().length > 0) await sql.unsafe(statement, []);
  }
}, 60_000);

afterAll(async () => {
  await sql?.end();
  if (url !== undefined) await admin(`drop database if exists ${PROBE_DB} with (force)`);
}, 60_000);

const STORES: readonly (readonly [string, () => Promise<DigestStore>])[] = [
  ['memory', () => Promise.resolve(memoryDigestStore())],
  [
    'postgres',
    async () => {
      await sql?.unsafe('truncate x_notify_digests', []);
      return postgresDigestStore({ executor: executor() });
    },
  ],
];

for (const [name, fresh] of STORES) {
  describe.skipIf(name === 'postgres' && url === undefined)(`${name} digest store`, () => {
    test('the first append opens the window and a later one inside it joins', async () => {
      const store = await fresh();
      expect(await append(store, 'e1', 0)).toEqual({ opened: true, endsAt: 100 });
      expect(await append(store, 'e2', 50)).toEqual({ opened: false, endsAt: 100 });
      expect(keys(await store.drain(slot, 100))).toEqual(['e1', 'e2']);
      expect(await store.drain(slot, 100)).toEqual([]);
    });

    test('an append after a window closed opens a second and keeps the first', async () => {
      const store = await fresh();
      await append(store, 'e1', 0);
      expect(await append(store, 'e2', 150)).toEqual({ opened: true, endsAt: 250 });
      expect(keys(await store.drain(slot, 100))).toEqual(['e1']);
      expect(keys(await store.drain(slot, 250))).toEqual(['e2']);
    });

    test('the next window’s drain collects one a crashed flush left, oldest first', async () => {
      const store = await fresh();
      await append(store, 'e1', 0);
      await append(store, 'e2', 150);
      expect(keys(await store.drain(slot, 250))).toEqual(['e1', 'e2']);
    });

    test('a drain naming no window takes the oldest alone', async () => {
      const store = await fresh();
      await append(store, 'e1', 0);
      await append(store, 'e2', 150);
      expect(keys(await store.drain(slot))).toEqual(['e1']);
      expect(keys(await store.drain(slot))).toEqual(['e2']);
    });

    test('a window holds its events whole, `at` a Date, and slots never mix', async () => {
      const store = await fresh();
      const other: DigestSlot = { ...slot, group: 'thread-2' };
      await append(store, 'e1', 10);
      expect(await append(store, 'x1', 20, other)).toEqual({ opened: true, endsAt: 120 });
      expect(await store.drain(slot, 110)).toEqual([event('e1', 10)]);
      expect(keys(await store.drain(other, 120))).toEqual(['x1']);
    });

    test('a replayed append answers what the first one did and lands its event once', async () => {
      const store = await fresh();
      expect(await append(store, 'e1', 0)).toEqual({ opened: true, endsAt: 100 });
      expect(await append(store, 'e2', 10)).toEqual({ opened: false, endsAt: 100 });
      // The step that appended re-runs whole: both appenders arrive a second time.
      expect(await append(store, 'e1', 20)).toEqual({ opened: true, endsAt: 100 });
      expect(await append(store, 'e2', 30)).toEqual({ opened: false, endsAt: 100 });
      expect(keys(await store.drain(slot, 100))).toEqual(['e1', 'e2']);
    });

    test('a replay after its window closed answers that window, never a new one', async () => {
      const store = await fresh();
      await append(store, 'e1', 0);
      expect(await append(store, 'e2', 150)).toEqual({ opened: true, endsAt: 250 });
      expect(await append(store, 'e1', 160)).toEqual({ opened: true, endsAt: 100 });
      expect(keys(await store.drain(slot, 250))).toEqual(['e1', 'e2']);
    });

    test('a drained window forgets its appenders: the same run in a later window opens it', async () => {
      const store = await fresh();
      await append(store, 'e1', 0);
      await store.drain(slot, 100);
      expect(await append(store, 'e1', 150)).toEqual({ opened: true, endsAt: 250 });
    });
  });
}

describe.skipIf(url === undefined)('postgres digest store, what a heap cannot do', () => {
  test('a window outlives the store that opened it', async () => {
    await sql?.unsafe('truncate x_notify_digests', []);
    await append(postgresDigestStore({ executor: executor() }), 'e1', 0);
    const restarted = postgresDigestStore({ executor: executor() });
    expect(await append(restarted, 'e2', 10)).toEqual({ opened: false, endsAt: 100 });
    expect(keys(await restarted.drain(slot, 100))).toEqual(['e1', 'e2']);
  });

  test('concurrent first appends open ONE window, so exactly one run owns the flush', async () => {
    await sql?.unsafe('truncate x_notify_digests', []);
    const buckets = await Promise.all(
      ['a', 'b', 'c', 'd'].map((key) =>
        append(postgresDigestStore({ executor: executor() }), key, 0),
      ),
    );
    expect(buckets.filter((bucket) => bucket.opened)).toHaveLength(1);
    const drained = await postgresDigestStore({ executor: executor() }).drain(slot, 100);
    expect([...keys(drained)].sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  test('two executions of ONE appender at once (a lapsed lease) land its event once', async () => {
    await sql?.unsafe('truncate x_notify_digests', []);
    if (sql === undefined) return expect.unreachable('beforeAll opened no database');
    // The first execution's insert is held uncommitted, so the second one's statement starts — and
    // takes its snapshot, in which `prior` finds nothing — before the first row is visible to it.
    const held = await sql.reserve();
    try {
      await held.unsafe('begin', []);
      const inTx: PgExecutor = {
        query: async <R>(text: string, values: readonly unknown[]): Promise<readonly R[]> =>
          [...(await held.unsafe(text, values.map(bound)))] as R[],
      };
      expect(await append(postgresDigestStore({ executor: inTx }), 'e1', 0)).toEqual({
        opened: true,
        endsAt: 100,
      });
      const racing = append(postgresDigestStore({ executor: executor() }), 'e1', 0);
      await waitForLockWait();
      await held.unsafe('commit', []);
      expect(await racing).toEqual({ opened: true, endsAt: 100 });
    } finally {
      held.release();
    }
    const rows = await sql.unsafe('select appended_by from x_notify_digests', []);
    expect([...rows]).toEqual([{ appended_by: ['run-e1'] }]);
    expect(keys(await postgresDigestStore({ executor: executor() }).drain(slot, 100))).toEqual([
      'e1',
    ]);
  });
});

/** Until a backend in the probe database is blocked on a lock — the racing statement, waiting. */
const waitForLockWait = async (): Promise<void> => {
  for (let poll = 0; poll < 100; poll += 1) {
    const [row] = await (sql?.unsafe(
      `select count(*)::int as waiting from pg_stat_activity
       where datname = '${PROBE_DB}' and wait_event_type = 'Lock'`,
      [],
    ) ?? []);
    if ((row as { waiting: number } | undefined)?.waiting) return;
    await Bun.sleep(20);
  }
  expect.unreachable('the racing append never blocked on the held insert');
};
