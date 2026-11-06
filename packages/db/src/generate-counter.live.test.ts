// `references(() => posts.id, { countedIn })` on a real Postgres: twenty concurrent inserts count twenty,
// a delete, a re-parent and a soft delete keep the count true, the recount repairs a drifted one,
// and drift names a dropped counter trigger with the statements that re-create it.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type PostgresClient, postgresClient } from './client';
import { diffSchema } from './drift';
import { recountDriftSql, recountSql } from './generate-counter';
import { snapshotOf } from './generate-snapshot';
import { recordTriggers } from './generate-triggers';
import { introspectSchema } from './introspect';
import { applyLifecycle, lifecycleEntities } from './lifecycle-live-fixture';
import { raw, sql } from './sql';

const url = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof url === 'string' && url.length > 0;
const P = 'cnt';
const ORG = '00000000-0000-0000-0000-0000000000aa';
const A = '00000000-0000-0000-0000-000000000001';
const B = '00000000-0000-0000-0000-000000000002';
const posts = raw(`"${P}_posts"`);
const likes = raw(`"${P}_likes"`);

describe.skipIf(!hasPostgres)('live · postgres · the counter trigger', () => {
  let client: PostgresClient;
  const counts = async (): Promise<number[]> =>
    (
      await client.query<{ like_count: number }>(sql`select like_count from ${posts} order by id`)
    ).map((row) => row.like_count);

  beforeAll(async () => {
    client = postgresClient({ url: url ?? '', profile: { max: 20 } });
    await applyLifecycle(client, P);
    for (const id of [A, B]) {
      await client.execute(
        sql`insert into ${posts} (id, org_id, title) values (${id}, ${ORG}, 't')`,
      );
    }
  });

  afterAll(async () => {
    await client.close();
  });

  test('twenty concurrent inserts count twenty', async () => {
    await Promise.all(
      Array.from({ length: 20 }, () =>
        client.execute(
          sql`insert into ${likes} (id, org_id, post_id) values (gen_random_uuid(), ${ORG}, ${A})`,
        ),
      ),
    );
    expect(await counts()).toEqual([20, 0]);
  });

  test('delete, re-parent, soft delete and a filtered delete stay true', async () => {
    await client.execute(
      sql`delete from ${likes} where id in (select id from ${likes} where post_id = ${A} limit 2)`,
    );
    expect(await counts()).toEqual([18, 0]);
    await client.execute(
      sql`update ${likes} set post_id = ${B} where id in (select id from ${likes} where post_id = ${A} limit 5)`,
    );
    expect(await counts()).toEqual([13, 5]);
    await client.execute(sql`update ${likes} set deleted_at = now() where post_id = ${B}`);
    expect(await counts()).toEqual([13, 0]);
    await client.execute(sql`delete from ${likes} where post_id = ${B}`);
    expect(await counts()).toEqual([13, 0]);
  });

  test('the recount repairs a drifted counter, and drift names a dropped trigger', async () => {
    const [counter] = lifecycleEntities(P)[0]?.counts ?? [];
    if (counter === undefined) return expect.unreachable('the fixture declares a counter');
    await client.execute(sql`update ${posts} set like_count = 99 where id = ${A}`);
    expect(await client.query(raw(recountDriftSql(`${P}_posts`, counter)))).toEqual([
      { key: A, stored: 99, actual: 13 },
    ]);
    await client.execute(raw(recountSql(`${P}_posts`, counter)));
    expect(await counts()).toEqual([13, 0]);

    const expected = recordTriggers(snapshotOf(lifecycleEntities(P)), lifecycleEntities(P));
    const ours = (await introspectSchema({ client })).tables.filter((t) => t.name.startsWith(P));
    expect(diffSchema({ tables: ours }, expected).differences).toEqual([]);
    const name = expected.tables.find((t) => t.name === `${P}_likes`)?.triggers?.[0]?.name ?? '';
    await client.execute(raw(`drop trigger "${name}" on "${P}_likes"`));
    const after = (await introspectSchema({ client })).tables.filter((t) => t.name.startsWith(P));
    const found = diffSchema({ tables: after }, expected).differences;
    expect(found.map((d) => [d.kind, d.table])).toEqual([
      ['missing-lifecycle-trigger', `${P}_likes`],
    ]);
    expect(found[0]?.fix).toContain(name);
  });
});
