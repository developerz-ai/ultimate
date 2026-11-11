/**
 * unit — `orgPosts` against the migrated database, where `created_at` keeps MICROSECONDS and a
 * cursor's `Date` keeps milliseconds. Rows written by `now()` sit between two cursor values, so a
 * push-down that seeks on the `Date` exactly skips them; every row must still be served, once.
 */

import { db } from '@postly/db';
import { migratedDatabase } from '@ultimat3/cli';
import { userActor } from '@ultimat3/core';
import { type DbClient, setDbClient, sql } from '@ultimat3/db';
import { afterAll, beforeAll, expect, reusableDatabase, unitTest } from '@ultimat3/testing';
import { orgPosts } from './org-posts';

const BOOT_MS = 120_000;
const workerDatabase = reusableDatabase(() => migratedDatabase({ root: import.meta.dir }));

let client: DbClient;
beforeAll(async () => {
  client = await workerDatabase();
  setDbClient(client);
}, BOOT_MS);
afterAll(() => setDbClient(undefined));

const ORG = '00000000-0000-4000-8000-0000000000c1';
const AUTHOR = '00000000-0000-4000-8000-0000000000c2';

unitTest('rows a millisecond cursor cannot name exactly still page completely', async () => {
  await db.orgs.insert({ id: ORG, slug: 'micros', name: 'Micros' });
  await db.members.insert({
    id: AUTHOR,
    orgId: ORG,
    userId: '00000000-0000-4000-8000-0000000000c3',
    email: 'micros@postly.dev',
    name: 'Micro Seconds',
  });
  // 30 posts over three milliseconds, ten per millisecond, each at its own microsecond.
  for (let n = 0; n < 30; n += 1) {
    const micros = String(Math.floor(n / 10) * 1000 + 101 + (n % 10) * 37).padStart(6, '0');
    await client.query(
      sql`insert into posts (id, org_id, author_id, slug, title, excerpt, body, created_at, updated_at)
          values (gen_random_uuid(), ${ORG}, ${AUTHOR}, ${`micro-${n}`}, ${`Micro ${n}`}, 'e', 'b',
                  ${`2027-01-01 00:00:00.${micros}+00`}::timestamptz, now())`,
    );
  }
  const actor = userActor({ id: AUTHOR, orgId: ORG });
  const unenforced = 'the paging mechanics, not the feed policy';

  const served: string[] = [];
  let after: string | undefined;
  for (let pages = 0; pages < 20; pages += 1) {
    const page = await orgPosts.page(
      { orgId: ORG },
      { first: 4, actor, unenforced, ...(after === undefined ? {} : { after }) },
    );
    served.push(...page.rows.map((row) => row.slug));
    if (page.nextCursor === null) break;
    after = page.nextCursor;
  }

  expect(new Set(served).size).toBe(served.length);
  expect([...served].sort()).toEqual(Array.from({ length: 30 }, (_, n) => `micro-${n}`).sort());
});
