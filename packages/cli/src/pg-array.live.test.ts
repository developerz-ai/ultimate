// The three shipped statements that bind an array, run against a real Postgres through the boot's
// own executor. Issue #384: `Bun.SQL` joins a JS array's elements with commas, so every one of them
// answered `malformed array literal` (22P02) — including `SQL_CLAIM`, which is the entire loop of
// every `ROLE=worker` container the framework produces.
//
// THIS FILE IS IN `@ultimat3/cli` BECAUSE NOTHING ELSE CAN SEE ALL THREE. `@ultimat3/db` is tier 1
// and may not import `jobs` (3) or `notify` (4); `jobs` and `notify` speak only the duck-typed
// `PgExecutor` and cannot build a db-backed one. `pgExecutorFor` over a real `PostgresClient` is
// the executor every booted role actually gets (`dev-queue.ts`), so this is the composition under
// test rather than a stand-in for it.
//
// WHY THE GAP LASTED: `grep -rln '\.claim(' --include=*.live.test.ts packages/` answered ONE file
// before this one, and it was written the same day. Every other test of these statements runs
// against a recording executor and asserts their SQL as TEXT, which cannot see whether a parameter
// parses. PGlite — what `x dev` runs — encodes an array correctly, so the framework's own dev loop
// was blind by construction and only a container ever met the failure.
//
// Skips unless `TEST_DATABASE_URL` is set. Locally:
//
//   docker run -d --rm --name x-array -e POSTGRES_PASSWORD=ultimate -e POSTGRES_USER=ultimate \
//     -e POSTGRES_DB=ultimate -p 55432:5432 postgres:17-alpine
//   TEST_DATABASE_URL=postgres://ultimate:ultimate@127.0.0.1:55432/ultimate \
//     bun test packages/cli/src/pg-array.live.test.ts

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PostgresClient } from '@ultimat3/db';
import { createPostgresClient, statementsOf } from '@ultimat3/db';
import type { PgExecutor } from '@ultimat3/jobs';
import { SQL_CLAIM, SQL_JOBS_TABLE, SQL_OUTBOX_RELEASE } from '@ultimat3/jobs';
import { SQL_NOTIFY_INBOX_MARK_READ, SQL_NOTIFY_INBOX_TABLE } from '@ultimat3/notify';
import { pgExecutorFor } from './dev-queue';

const url = Bun.env['TEST_DATABASE_URL'];
const describeLive = url === undefined ? describe.skip : describe;

const ID = '019b76da-a800-7397-9d07-a63ca80b3c96';

let client: PostgresClient | undefined;
let executor: PgExecutor | undefined;

beforeAll(async () => {
  if (url === undefined) return;
  client = createPostgresClient({ url, role: 'worker' });
  executor = pgExecutorFor(client);
  // `statementsOf` and not `split(';')`: the DDL carries comments and the package's own splitter is
  // the one answer to where a statement ends.
  for (const ddl of [SQL_JOBS_TABLE, SQL_NOTIFY_INBOX_TABLE]) {
    for (const statement of statementsOf(ddl)) await executor.query(statement, []);
  }
});

afterAll(async () => {
  await client?.close();
});

describeLive('live · postgres · the shipped statements that bind an array', () => {
  // The worker's whole loop. Nothing asserted about the ROWS — an empty queue returns none, and the
  // claim is what the test is about: this statement raised 22P02 on every call, so a worker against
  // a real Postgres never claimed anything and every job sat in the queue forever.
  test('SQL_CLAIM executes — the loop every ROLE=worker container runs', async () => {
    expect(SQL_CLAIM).toContain('any($1::text[])');
    const rows = await executor?.query(SQL_CLAIM, [['default', 'mail'], 1, 'w1', 30_000]);
    expect(rows).toEqual([]);
  });

  test('SQL_OUTBOX_RELEASE executes — the relay giving a batch back', async () => {
    expect(SQL_OUTBOX_RELEASE).toContain('any($1::uuid[])');
    await executor?.query(SQL_OUTBOX_RELEASE, [[ID], 'relay-1']);
  });

  test('SQL_NOTIFY_INBOX_MARK_READ executes — an in-app notification being read', async () => {
    expect(SQL_NOTIFY_INBOX_MARK_READ).toContain('any($2::uuid[])');
    await executor?.query(SQL_NOTIFY_INBOX_MARK_READ, ['ada', [ID], new Date()]);
  });

  // A claim that executes is not yet a claim that MATCHES. `any` over a mis-encoded array could
  // match nothing and still not throw, which would leave the three tests above green over a worker
  // that claims no job — the same shape of green this whole issue is about.
  test('the claim really matches on the queue names it was given', async () => {
    const rows = await executor?.query<{ id: string; queue: string }>(
      // `$2` and not `$1` again: one placeholder in both a uuid and a text column deduces two
      // types and Postgres refuses the statement (42P08) before any array is bound.
      `insert into x_jobs (id, name, queue, input, idempotency_key, run_id)
       values ($1, 'probe', 'mail', '{}'::jsonb, $2, $1) returning id, queue`,
      [ID, ID],
    );
    expect(rows?.[0]?.queue).toBe('mail');
    try {
      const claimed = await executor?.query<{ id: string }>(SQL_CLAIM, [
        ['default', 'mail'],
        5,
        'w-match',
        30_000,
      ]);
      expect(claimed?.map((row) => row.id)).toEqual([ID]);
    } finally {
      await executor?.query('delete from x_jobs where id = $1', [ID]);
    }
  });

  // The negative control on the same statement: a queue the array does NOT name must not be
  // claimed, or the test above is satisfied by an encoder that turns every array into a wildcard.
  test('a queue the array does not name is not claimed', async () => {
    await executor?.query(
      `insert into x_jobs (id, name, queue, input, idempotency_key, run_id)
       values ($1, 'probe', 'reports', '{}'::jsonb, $2, $1)`,
      [ID, ID],
    );
    try {
      const claimed = await executor?.query(SQL_CLAIM, [['default', 'mail'], 5, 'w-miss', 30_000]);
      expect(claimed).toEqual([]);
    } finally {
      await executor?.query('delete from x_jobs where id = $1', [ID]);
    }
  });
});
