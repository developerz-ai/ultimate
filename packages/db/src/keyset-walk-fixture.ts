// Test-only: the one walk both engines run `keyset()` through — Postgres in `keyset.live.test.ts`,
// PGlite in `keyset-embedded.test.ts` — so the two suites cannot disagree about what was asked.
// Three rows inside ONE millisecond, written as SQL: a JS `Date` cannot hold what they differ by.

import { expect } from 'bun:test';
import type { DbClient } from './client';
import type { KeysetKey } from './keyset';
import { keyset } from './keyset';
import { raw, sql } from './sql';

export const KEYSET_TABLE = 'keyset_walk_events';

/** Adversarial ids: under `desc` the boundary row holds its millisecond's LARGEST id. */
const SEEDED: readonly (readonly [string, string])[] = [
  ['00000000-0000-7000-8000-000000000003', '2026-01-01T00:00:00.123900Z'],
  ['00000000-0000-7000-8000-000000000001', '2026-01-01T00:00:00.123500Z'],
  ['00000000-0000-7000-8000-000000000002', '2026-01-01T00:00:00.123100Z'],
  ['00000000-0000-7000-8000-000000000004', '2026-01-01T00:00:00.122000Z'],
];

/** `created_at desc, id desc`: only the microsecond field separates the first three. */
export const DESCENDING = ['…0003', '…0001', '…0002', '…0004'];

/** The table, its index on the order, and the rows; `filler` more rows for the planner to weigh. */
export async function seedKeysetTable(client: DbClient, filler = 0): Promise<void> {
  await client.execute(raw(`drop table if exists ${KEYSET_TABLE}`));
  await client.execute(
    raw(
      `create table ${KEYSET_TABLE} (id uuid not null primary key, created_at timestamptz not null, title text not null)`,
    ),
  );
  await client.execute(
    raw(`create index ${KEYSET_TABLE}_order on ${KEYSET_TABLE} (created_at desc, id desc)`),
  );
  for (const [id, at] of SEEDED) {
    await client.execute(
      sql`insert into ${raw(KEYSET_TABLE)} (id, created_at, title) values (${id}::uuid, ${at}::timestamptz, 'seeded')`,
    );
  }
  if (filler > 0) {
    // Before the seeded rows in time, so a walk from the top meets the seeded four first.
    await client.execute(
      sql`insert into ${raw(KEYSET_TABLE)} (id, created_at, title)
          select gen_random_uuid(), timestamptz '2025-01-01' - n * interval '1 second', 'filler'
          from generate_series(1, ${filler}::integer) as n`,
    );
  }
  await client.execute(raw(`analyze ${KEYSET_TABLE}`));
}

export const keysFor = (direction: 'asc' | 'desc'): readonly KeysetKey[] => [
  { column: raw('e.created_at'), kind: 'timestamptz', direction },
  { column: raw('e.id'), kind: 'uuid', direction },
];

const shortId = (row: { readonly id: string }): string => `…${row.id.slice(-4)}`;

/** The statement one page sends: a raw read with the four fragments spliced in. */
export const pageStatement = (page: ReturnType<typeof keyset>) =>
  sql`select e.id::text as id, ${page.select} from ${raw(KEYSET_TABLE)} e
      where e.title = ${'seeded'} and ${page.where}
      order by ${page.orderBy} limit ${page.limit}`;

/** Every seeded row, page by page from the top. Bounded: a seek that stops advancing fails. */
export async function walkKeyset(
  client: DbClient,
  direction: 'asc' | 'desc',
  limit: number,
): Promise<string[]> {
  const seen: string[] = [];
  let after: string | null = null;
  for (let turn = 0; turn < 10; turn += 1) {
    const page = keyset({ scope: 'events.walk', keys: keysFor(direction), after, limit });
    const result = page.page(await client.query<{ id: string }>(pageStatement(page)));
    seen.push(...result.rows.map(shortId));
    if (!result.hasMore) return seen;
    after = result.nextCursor;
  }
  return expect.unreachable('the walk never reached its last page');
}

/** `explain` of the first page over every row, as plain text lines. */
export async function firstPagePlan(client: DbClient): Promise<string> {
  const page = keyset({ scope: 'events.plan', keys: keysFor('desc'), after: null, limit: 50 });
  const statement = sql`explain select ${page.select} from ${raw(KEYSET_TABLE)} e
      where ${page.where} order by ${page.orderBy} limit ${page.limit}`;
  const rows = await client.query<{ 'QUERY PLAN': string }>(statement);
  return rows.map((row) => row['QUERY PLAN']).join('\n');
}
