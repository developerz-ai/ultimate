// `entity({ history: true })` on a real Postgres: the trigger records a before and an after image of
// a raw update and a multi-row update alike, a no-op update and a counter-only change record nothing,
// the actor is the write transaction's, and the history table refuses every rewrite but its purge's.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type PostgresClient, postgresClient } from './client';
import { applyLifecycle } from './lifecycle-live-fixture';
import { raw, sql } from './sql';
import { sqlState } from './sqlstate';
import { withTransaction } from './transaction';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const P = 'hst';
const ORG = '00000000-0000-0000-0000-0000000000aa';
const POST = '00000000-0000-0000-0000-000000000001';
const OTHER = '00000000-0000-0000-0000-000000000002';

interface Image {
  readonly op: string;
  readonly row_id: string;
  readonly actor_id: string | null;
  readonly org_id: string;
  readonly before: { readonly title?: string } | null;
  readonly after: { readonly title?: string } | null;
}

describe.skipIf(!hasPostgres)('live · postgres · the history trigger', () => {
  let client: PostgresClient;
  const images = (): Promise<readonly Image[]> =>
    client.query<Image>(raw(`select * from "${P}_posts_history" order by at, op`));
  const refusedState = async (send: Promise<unknown>): Promise<string | undefined> => {
    try {
      await send;
    } catch (error) {
      return sqlState((error as { sourceError?: unknown }).sourceError ?? error);
    }
    return expect.unreachable('the history table accepted a rewrite');
  };

  beforeAll(async () => {
    client = postgresClient({ url: url ?? '' });
    await applyLifecycle(client, P);
    for (const id of [POST, OTHER]) {
      await client.execute(
        sql`insert into ${raw(`"${P}_posts"`)} (id, org_id, title) values (${id}, ${ORG}, 'a')`,
      );
    }
  });

  afterAll(async () => {
    await client.close();
  });

  test('raw and multi-row updates record images, with the transaction actor', async () => {
    await client.execute(raw(`update "${P}_posts" set title = 'b' where id = '${POST}'`));
    await client.execute(raw(`update "${P}_posts" set title = title`));
    await client.execute(raw(`update "${P}_posts" set like_count = 7`));
    await client.execute(raw(`update "${P}_posts" set title = 'c'`));
    await withTransaction(
      async (tx) => {
        await tx.execute(sql`select set_config('x.actor', 'member-1', true)`);
        await tx.execute(raw(`update "${P}_posts" set title = 'd' where id = '${POST}'`));
      },
      { client },
    );
    const rows = await images();
    const mine = rows.filter((row) => row.row_id === POST);
    expect(
      mine.map((row) => [row.op, row.before?.title ?? null, row.after?.title ?? null]),
    ).toEqual([
      ['insert', null, 'a'],
      ['update', 'a', 'b'],
      ['update', 'b', 'c'],
      ['update', 'c', 'd'],
    ]);
    expect(mine.map((row) => row.actor_id)).toEqual([null, null, null, 'member-1']);
    expect(rows.every((row) => row.org_id === ORG)).toBe(true);
    // Two inserts, then three real updates of POST and one of OTHER: no-op and counter-only nothing.
    expect(rows).toHaveLength(6);
  });

  test('a delete of history is refused, except under x.purge naming this table', async () => {
    expect(await refusedState(client.execute(raw(`delete from "${P}_posts_history"`)))).toBe(
      '23001',
    );
    expect(
      await refusedState(client.execute(raw(`update "${P}_posts_history" set op = 'x'`))),
    ).toBe('23001');
    const elsewhere = withTransaction(
      async (tx) => {
        await tx.execute(sql`select set_config('x.purge', ${`${P}_posts`}, true)`);
        await tx.execute(raw(`delete from "${P}_posts_history"`));
      },
      { client },
    );
    expect(await refusedState(elsewhere)).toBe('23001');
    await withTransaction(
      async (tx) => {
        await tx.execute(sql`select set_config('x.purge', ${`${P}_posts_history`}, true)`);
        await tx.execute(raw(`delete from "${P}_posts_history"`));
      },
      { client },
    );
    expect(await images()).toHaveLength(0);
  });
});
