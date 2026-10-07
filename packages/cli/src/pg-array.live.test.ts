// The shipped inbox write that binds an array, run against a real Postgres through the boot's own
// executor. Issue #384: `Bun.SQL` joins a JS array's elements with commas, so every statement that
// bound one answered `malformed array literal` (22P02) — the worker's claim, the relay's release,
// and an in-app notification being read.
//
// THE NOTIFY CASE IS HERE BECAUSE `@ultimat3/notify` CANNOT SEE THE EXECUTOR. It depends on no
// driver (`packages/notify/package.json`), so it cannot build the `PostgresClient`-backed executor
// every booted role gets; `@ultimat3/db`'s `dbExecutor` can, and that composition is what is
// under test. It goes through `postgresInboxStore().markRead()`, the public path, so the statement
// stays unexported (`sql-export-readers`: a test outside a package reads its `*_TABLE` only). The
// jobs statements are tested in their own package: `jobs/src/driver-pg-array.live.test.ts`.
//
// WHY THE GAP LASTED: every other test of these statements runs against a recording executor and
// asserts their SQL as TEXT, which cannot see whether a parameter parses. PGlite — what `x dev`
// runs — encodes an array correctly, so the framework's own dev loop was blind by construction and
// only a container ever met the failure.
//
// Skips unless `TEST_DATABASE_URL` is set. Locally:
//
//   docker run -d --rm --name x-array -e POSTGRES_PASSWORD=ultimate -e POSTGRES_USER=ultimate \
//     -e POSTGRES_DB=ultimate -p 55432:5432 postgres:17-alpine
//   TEST_DATABASE_URL=postgres://ultimate:ultimate@127.0.0.1:55432/ultimate \
//     bun test packages/cli/src/pg-array.live.test.ts

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { PgExecutor } from '@ultimat3/core';
import type { PostgresClient } from '@ultimat3/db';
import { dbExecutor, postgresClient, statementsOf } from '@ultimat3/db';
import { postgresInboxStore, SQL_NOTIFY_INBOX_TABLE } from '@ultimat3/notify';

const url = Bun.env['TEST_DATABASE_URL'];
const describeLive = url === undefined ? describe.skip : describe;

// Every value this file writes or matches on is minted per run: `TEST_DATABASE_URL` may name a
// database that already holds inbox rows — CI's does — and a fixed recipient would read them.
const RUN = crypto.randomUUID().slice(0, 8);
const RECIPIENT = `ada-${RUN}`;
const NOT_A_ROW = crypto.randomUUID();

let client: PostgresClient | undefined;
let executor: PgExecutor | undefined;

beforeAll(async () => {
  if (url === undefined) return;
  client = postgresClient({ url, role: 'worker' });
  const open = client;
  executor = dbExecutor(() => open);
  // `statementsOf` and not `split(';')`: the DDL carries comments and the package's own splitter is
  // the one answer to where a statement ends.
  for (const statement of statementsOf(SQL_NOTIFY_INBOX_TABLE)) {
    await executor.query(statement, []);
  }
});

afterAll(async () => {
  await executor?.query('delete from x_notify_inbox where recipient = $1', [RECIPIENT]);
  await client?.close();
});

describeLive('live · postgres · the inbox write that binds an array', () => {
  // `markRead` binds its ids as `any($2::uuid[])`. Executing is not enough — an encoder that turned
  // the array into a wildcard, or into nothing, would execute too — so the marked COUNT and the
  // unread count after it are the assertion, with an id that names no row in the same array.
  test('markRead marks exactly the rows its array names — an in-app notification being read', async () => {
    if (executor === undefined) return expect.unreachable('beforeAll built no executor');
    const store = postgresInboxStore({ executor });
    const at = new Date('2026-10-06T12:00:00Z');
    const read = await store.add({
      recipient: RECIPIENT,
      notifier: 'post.commented',
      key: `read-${RUN}`,
      params: {},
      createdAt: at,
    });
    await store.add({
      recipient: RECIPIENT,
      notifier: 'post.commented',
      key: `unread-${RUN}`,
      params: {},
      createdAt: at,
    });

    const marked = await store.markRead({ recipient: RECIPIENT, ids: [read.id, NOT_A_ROW], at });

    expect(marked).toBe(1);
    expect(await store.unreadCount(RECIPIENT)).toBe(1);
  });
});
