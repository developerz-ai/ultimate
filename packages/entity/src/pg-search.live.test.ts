// `.searchable()` against a real server: the generated `tsvector`, the GIN index the planner
// actually picks, tsquery punctuation arriving from a search box, the tenant predicate riding
// along, and a paged walk that neither drops nor repeats a row.
//
// A SQL-text assertion cannot answer any of those. `websearch_to_tsquery('english', $1)` looks
// identical whether or not the column it is compared against is populated, whether or not the
// planner can use the index, and whether or not `&` was read as an operator — only the server
// knows, which is why every claim in this file is measured rather than pinned as text.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  createPostgresClient,
  generateMigration,
  type PostgresClient,
  raw,
  setDbClient,
  sql,
  statementsOf,
} from '@ultimat3/db';
import { text, uuid } from './columns';
import { entity } from './entity';
import { memoryRepo } from './memory-repo';
import { postgresRepo } from './pg-driver';
import { countStatement } from './pg-sql';
import { planFor as buildPlan } from './plan';
import { clearRegistry } from './registry';
import { SEARCH_PROPERTY } from './search';
import type { Predicate } from './tenancy';

const adminUrl = Bun.env['TEST_DATABASE_URL'];
const hasPostgres = typeof adminUrl === 'string' && adminUrl.length > 0;

const posts = entity('pg_search_posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    title: text({ max: 120 }).searchable('A'),
    body: text({ max: 400 }).nullable().searchable(),
  },
});

type Post = typeof posts.$row;

const DROP = 'drop table if exists "pg_search_posts" cascade';

const ORG_A = '00000000-0000-7000-8000-00000000aaaa';
const ORG_B = '00000000-0000-7000-8000-00000000bbbb';

const id = (index: number): string =>
  `00000000-0000-7000-8000-0000000006${String(index).padStart(2, '0')}`;

const SEEDED: readonly Post[] = [
  { id: id(1), orgId: ORG_A, title: 'Running a database', body: 'postgres and indexes' },
  { id: id(2), orgId: ORG_A, title: 'Cats and dogs', body: 'a story about animals' },
  { id: id(3), orgId: ORG_A, title: 'Quiet mornings', body: null },
  // The cross-tenant control: it matches every term the org A rows match.
  { id: id(4), orgId: ORG_B, title: 'Running a database', body: 'cats and dogs and postgres' },
];

/** Every id the paging walk has to see exactly once, all in org A, all matching `phrase`. */
const PAGED: readonly Post[] = Array.from({ length: 30 }, (_, index) => ({
  id: id(index + 10),
  orgId: ORG_A,
  title: `paged entry ${index}`,
  body: 'shared searchable phrase',
}));

const search = (term: string): Predicate => ({
  column: SEARCH_PROPERTY,
  op: 'matches',
  value: term,
});

const tenant = (org: string): Predicate => ({ column: 'orgId', op: 'eq', value: org });

describe.skipIf(!hasPostgres)('live · postgres · full-text search', () => {
  let client: PostgresClient;

  beforeAll(async () => {
    client = createPostgresClient({ url: adminUrl ?? '' });
    setDbClient(client);
    await client.execute(raw(DROP));
    const migration = generateMigration({
      entities: [posts.$describe()],
      name: 'live search',
      now: new Date('2026-08-24T00:00:00.000Z'),
    });
    for (const statement of statementsOf(migration.up)) await client.execute(raw(statement));

    // THE ASSERTION THIS WHOLE FILE TURNS ON, and it is in `beforeAll` deliberately: every test
    // below reads a table the FRAMEWORK'S OWN MIGRATION created. Until 2026-08-24 this block was a
    // hand-written `drop column` + `add column … generated always as (…) stored`, because
    // `columnClause` did not render the clause — so the suite proved that search works against a
    // column no shipped code path could produce. That is the difference between "search works" and
    // "search works when you apply the migration the framework wrote", and only the second one is
    // a feature.
    expect(migration.up).toContain(`generated always as (${posts.$search?.expression}) stored`);

    await postgresRepo(posts).insertAll([...SEEDED, ...PAGED]);
  });

  afterAll(async () => {
    await client.execute(raw(DROP));
    await client.close();
    setDbClient(undefined);
  });

  const titles = async (term: string, org: string = ORG_A): Promise<readonly string[]> => {
    const page = await postgresRepo(posts).findMany({
      where: [tenant(org), search(term)],
      orderBy: [{ column: 'id', direction: 'asc' }],
      limit: 100,
    });
    return page.rows.map((row) => row.title);
  };

  test('the generated column is computed by the database, from every searchable column', async () => {
    // Stemming is the proof that this is a real `tsvector` and not a `like`: `running` is stored as
    // the lexeme `run`, so a search for `run` finds it and a substring match never would.
    expect(await titles('run')).toEqual(['Running a database']);
    // And the second source column reaches the same vector.
    expect(await titles('animals')).toEqual(['Cats and dogs']);
    // A NULL source erases nothing: `coalesce(…, '')` is why row 3 has a vector at all.
    expect(await titles('mornings')).toEqual(['Quiet mornings']);
  });

  test('tsquery punctuation from a search box is TEXT, never syntax and never an error', async () => {
    // Every one of these is a `42601`, a `22P02` or a silently different query under bare
    // `to_tsquery`. Under `websearch_to_tsquery` they are terms, and the row still comes back.
    for (const term of ['cats & dogs', 'cats:* dogs', 'cats!dogs', '(((cats', 'cats <-> dogs']) {
      expect(await titles(term), term).toEqual(['Cats and dogs']);
    }
    // `!` as the first character is the one shape bare `to_tsquery` would read as NOT — the exact
    // inversion an injected operator produces. Here it is punctuation and `cats` is the term.
    expect(await titles('!cats')).toEqual(['Cats and dogs']);
    // A term nothing matches is no rows, never an error.
    expect(await titles('|||')).toEqual([]);
    expect(await titles('')).toEqual([]);
  });

  test("websearch's own operators still mean what a search box means", async () => {
    // The reason this parser rather than `plainto_tsquery`: a quoted phrase and `-negation` are
    // what every user already expects, and `plainto_tsquery` throws both away in silence.
    expect(await titles('"cats and dogs"')).toEqual(['Cats and dogs']);
    expect(await titles('database -postgres')).toEqual([]);
    expect(await titles('mornings or animals')).toEqual(['Cats and dogs', 'Quiet mornings']);
  });

  test('the tenant predicate rides with every search', async () => {
    // Org B's row matches every one of these terms and is on none of the answers.
    expect(await titles('run')).toEqual(['Running a database']);
    expect(await titles('cats')).toEqual(['Cats and dogs']);
    // Asked as org B, the same terms answer org B's row and nothing of org A's.
    expect(await titles('cats', ORG_B)).toEqual(['Running a database']);
  });

  /**
   * The driver's OWN statement, explained — never a hand-written lookalike. `countStatement` and
   * not `selectStatement`, for the reason `pg-containment.live.test.ts` gives: a page carries
   * `order by` and a `limit`, and the planner can satisfy both by walking an index whatever the
   * predicate could have used, which hides the decision this test is about.
   */
  const planOf = async (where: readonly Predicate[]): Promise<string> => {
    const statement = countStatement(posts, buildPlan(posts, { where, limit: 50 }), {
      includeDeleted: false,
    });
    const rows = await client.query<Record<string, string>>(sql`explain (costs off) ${statement}`);
    return rows.map((row) => row['QUERY PLAN'] ?? '').join('\n');
  };

  test('the declared GIN index is matched by the match predicate the driver emits', async () => {
    await client.execute(raw(`analyze "${posts.$table}"`));
    // `enable_seqscan = off` because the corpus is 34 rows: this asks whether the index CAN serve
    // `@@`, which is a property of the operator class, not whether it is cheapest at this size.
    // Measured separately on 20,000 rows: same plan, `Bitmap Index Scan` with the `@@` as its
    // Index Cond — so the operator is index-matched, which is the claim a declared index rests on.
    await client.execute(raw('set enable_seqscan = off'));
    const plan = await planOf([search('postgres')]);
    const gin = posts.$indexes.find((index) => index.using === 'gin');
    expect(gin?.name).toBeDefined();
    expect(plan).toContain(gin?.name ?? '');
    expect(plan).toContain('Bitmap Index Scan');
    // The `@@` is the INDEX CONDITION, not a filter over rows some other index found — the exact
    // distinction that made `jsonb_exists(col, $1)` unindexable while `col ? $1` is not.
    expect(plan).toContain('Index Cond');
    await client.execute(raw('set enable_seqscan = on'));
  });

  test('with a tenant predicate the planner may prefer the TENANT index, and that is Postgres', async () => {
    // Pinned as a measured fact rather than left for a reader to wonder about, the same way the
    // containment suite pins `jsonb <@` as a Seq Scan. Two selective predicates and Postgres picks
    // one index and filters with the other; on 20,000 rows across two orgs it chose the org btree
    // even with `enable_seqscan` and `enable_indexscan` both off, because `@@`'s default
    // selectivity estimate is coarser than an equality on a uuid.
    //
    // The fix is a COMPOSITE `(org_id, search_tsv)` GIN, which needs the `btree_gin` extension to
    // get a uuid into a GIN index — an extension is a deployment decision and an opclass is a
    // spelling `IndexInit` does not have, so neither is declarable today. Filtering inside one
    // tenant is a correct plan and a bounded one; it is the tenant with millions of rows that wants
    // the composite index.
    await client.execute(raw('set enable_seqscan = off'));
    const plan = await planOf([tenant(ORG_A), search('postgres')]);
    expect(plan).toContain('org_id');
    expect(plan).toContain('search_tsv @@');
    await client.execute(raw('set enable_seqscan = on'));
  });

  test('a paged search over 30 tied rows drops nothing and repeats nothing', async () => {
    // Every one of these matches identically, so relevance cannot separate them — which is exactly
    // the shape that breaks a pager: the order is the DECLARED one and the cursor carries it.
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const answer = await postgresRepo(posts).findMany({
        where: [tenant(ORG_A), search('"shared searchable phrase"')],
        orderBy: [{ column: 'title', direction: 'asc' }],
        limit: 7,
        cursor,
      });
      seen.push(...answer.rows.map((row) => row.id));
      cursor = answer.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toHaveLength(PAGED.length);
    expect(new Set(seen).size).toBe(PAGED.length);
    expect([...seen].sort()).toEqual([...PAGED].map((row) => row.id).sort());
  });

  test('the in-memory driver refuses the same read rather than answering it differently', async () => {
    // The parity rule inverted, deliberately: `to_tsvector` stems and `websearch_to_tsquery` parses
    // phrases, so a JS token comparison is a different question wearing the same call. Refusing is
    // the only answer memory can give that Postgres will not contradict.
    await expect(
      memoryRepo(posts, SEEDED).findMany({ where: [tenant(ORG_A), search('run')], limit: 10 }),
    ).rejects.toMatchObject({ code: 'X_SEARCH_IN_MEMORY' });
  });
});

// Outside the block above and unconditional: bun runs no hook inside a skipped `describe`, and the
// registry is process-wide. `live-registry-cleanup.test.ts` is the rule that keeps it here.
afterAll(() => {
  clearRegistry();
});
