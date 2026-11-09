// The factories on PGlite — `@ultimat3/db`'s embedded Postgres — through `entityPersister({ client })`:
// `create()` answers what `returning *` stored, the foreign keys hold under real constraints, and
// the children land after their parent in its tenant. The memory suites prove the same shapes.

import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { type PgliteClient, pgliteClient, sql } from '@ultimat3/db';
import { factoryWorld } from './factory-fixture';
import { clearPersister, entityPersister, usePersister } from './factory-persist';
import { testName } from './test-types';

/** A cold PGlite boot. */
const PGLITE_MS = 60_000;

const DDL = [
  sql`create table ff_orgs (id uuid primary key, name text not null)`,
  sql`create table ff_posts (id uuid primary key, org_id uuid not null references ff_orgs(id), title varchar(80) not null, views integer not null default 0, created_at timestamptz not null default now())`,
  sql`create table ff_comments (id uuid primary key, org_id uuid not null references ff_orgs(id), post_id uuid not null references ff_posts(id), body text not null)`,
];

describe(testName('unit', 'factories on PGlite'), () => {
  const opened: PgliteClient[] = [];
  afterAll(async () => {
    for (const client of opened) await client.close();
  });
  afterEach(() => {
    clearPersister();
  });

  test(
    'create answers the stored row, parents first and children after, in one tenant',
    async () => {
      const client = pgliteClient();
      opened.push(client);
      for (const statement of DDL) await client.execute(statement);
      const { postFactory } = factoryWorld();
      usePersister(entityPersister({ client }));
      const post = await postFactory.create({ comments: 2 });
      const [stored] = await client.query<{ views: number; created_at: Date; org_id: string }>(
        sql`select views, created_at, org_id from ff_posts where id = ${post.id}`,
      );
      expect(stored?.views).toBe(0);
      expect(post.views).toBe(0);
      expect(post.createdAt.getTime()).toBe(stored?.created_at.getTime() ?? Number.NaN);
      const children = await client.query<{ org_id: string }>(
        sql`select org_id from ff_comments where post_id = ${post.id}`,
      );
      expect(children.map((row) => row.org_id)).toEqual([post.orgId, post.orgId]);
      const [orgCount] = await client.query<{ n: number }>(
        sql`select count(*)::int as n from ff_orgs`,
      );
      expect(orgCount?.n).toBe(1);
    },
    PGLITE_MS,
  );
});
