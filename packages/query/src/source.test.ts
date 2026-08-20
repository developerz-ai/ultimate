// Parity between the two halves of one source: the SQL text a driver receives and the rows
// `execute()` answers from memory. `from()` is the reference implementation an app's `sql:` is
// modelled on, so a filter, an ordering or a seek that means one thing in the generated statement
// and another in the fixture rows is a defect an app inherits — these read both and compare.

import { describe, expect, test } from 'bun:test';
import type { OrderKey } from './shape';
import { from, isAfterKey } from './source';

interface Post {
  readonly id: string;
  readonly orgId: string;
  readonly publishedAt: string | null;
  readonly score: number | null;
}

const ORG = 'org-1';

/** Two published rows and two drafts: the shape every `deletedAt`/`publishedAt` listing has. */
const posts: readonly Post[] = [
  { id: 'a', orgId: ORG, publishedAt: '2026-01-01', score: 10 },
  { id: 'b', orgId: ORG, publishedAt: '2026-02-01', score: null },
  { id: 'c', orgId: ORG, publishedAt: null, score: 3 },
  { id: 'd', orgId: ORG, publishedAt: null, score: 7 },
];

const feed = (): ReturnType<typeof from<Post>> => from<Post>('posts', posts);
const ids = (rows: readonly Post[]): readonly string[] => rows.map((row) => row.id);

const ASC: readonly OrderKey[] = [{ column: 'publishedAt', direction: 'asc' }];
const DESC: readonly OrderKey[] = [{ column: 'publishedAt', direction: 'desc' }];

/**
 * `= $n` with a NULL parameter is unknown in Postgres and unknown is never true, so a filter that
 * matched every draft in memory returned nothing at all from the database.
 */
describe('a filter on NULL compiles to `is null`', () => {
  test('`where({ col: null })` binds no parameter and reads the drafts', async () => {
    const source = feed().where({ publishedAt: null });
    expect(source.toSQL()).toEqual({
      sql: 'select * from "posts" where "publishedAt" is null',
      params: [],
    });
    expect(ids(await source.execute())).toEqual(['c', 'd']);
  });

  test('`!= null` is `is not null`, not a parameter that never matches', async () => {
    const source = feed().compare('publishedAt', '!=', null);
    expect(source.toSQL()).toEqual({
      sql: 'select * from "posts" where "publishedAt" is not null',
      params: [],
    });
    expect(ids(await source.execute())).toEqual(['a', 'b']);
  });

  test('`!= value` is `is distinct from`, so a NULL row counts as different', async () => {
    const source = feed().compare('publishedAt', '!=', '2026-01-01');
    expect(source.toSQL().sql).toContain('"publishedAt" is distinct from $1');
    expect(ids(await source.execute())).toEqual(['b', 'c', 'd']);
  });

  test('`in` reaches the NULLs beside the listed values', async () => {
    const source = feed().compare('publishedAt', 'in', [null, '2026-01-01']);
    expect(source.toSQL()).toEqual({
      sql: 'select * from "posts" where ("publishedAt" in ($1) or "publishedAt" is null)',
      params: ['2026-01-01'],
    });
    expect(ids(await source.execute())).toEqual(['a', 'c', 'd']);
  });

  test('an empty `in` is a constant, never `in ()` — a syntax error Postgres refuses', async () => {
    const source = feed().compare('publishedAt', 'in', []);
    expect(source.toSQL()).toEqual({ sql: 'select * from "posts" where 1 = 0', params: [] });
    expect(await source.execute()).toEqual([]);
  });

  test('an `in` given no list is the same constant, not `in $1` — which no driver can read', async () => {
    const source = feed().compare('publishedAt', 'in', '2026-01-01');
    // `matchesFilter` answers no row for a non-list operand, so the SQL says exactly that. The
    // bound-parameter fallback said `"publishedAt" in $1`, which is a syntax error a driver
    // reports instead of the empty result the two halves agree on.
    expect(source.toSQL()).toEqual({ sql: 'select * from "posts" where 1 = 0', params: [] });
    expect(await source.execute()).toEqual([]);
  });

  test('an ordering operator needs no case: NULL matches nothing on either side', async () => {
    const source = feed().compare('score', '>', 5);
    expect(source.toSQL().sql).toContain('"score" > $1');
    // `b` has no score. The database skips it; the string compare used to sort it past `5`.
    expect(ids(await source.execute())).toEqual(['a', 'd']);
    expect(await feed().compare('score', '>', null).execute()).toEqual([]);
  });
});

/**
 * Postgres already defaults to `nulls last` ascending and `nulls first` descending. Writing it
 * down is what keeps the seek predicate, the in-memory sort and the live matcher from drifting.
 */
describe('the ordering says where NULL goes', () => {
  test('`asc` is `nulls last`, in the SQL and in the rows', async () => {
    const source = feed().orderBy('publishedAt');
    expect(source.toSQL().sql).toBe('select * from "posts" order by "publishedAt" asc nulls last');
    expect(ids(await source.execute())).toEqual(['a', 'b', 'c', 'd']);
  });

  test('`desc` is `nulls first`, in the SQL and in the rows', async () => {
    const source = feed().orderBy('publishedAt', 'desc');
    expect(source.toSQL().sql).toBe(
      'select * from "posts" order by "publishedAt" desc nulls first',
    );
    expect(ids(await source.execute())).toEqual(['c', 'd', 'b', 'a']);
  });
});

/**
 * `total()` is how a read that has no cursor still asks for the order a cursor read is served in —
 * a live window, whose patches the matcher places by `totalOrder`. Without it the window arrives
 * ordered by the declared keys alone and a tie sits wherever the rows happened to be.
 */
describe('total() serves the declared keys plus the id tiebreak', () => {
  /** Two rows tied on the only declared key, given to the source in the wrong id order. */
  const tied: readonly Post[] = [
    { id: 'y', orgId: ORG, publishedAt: '2026-01-01', score: 1 },
    { id: 'x', orgId: ORG, publishedAt: '2026-01-01', score: 2 },
  ];

  test('appends `"id" asc` to the statement and to the rows', async () => {
    const source = from<Post>('posts', tied).orderBy('publishedAt').total();
    expect(source.toSQL().sql).toBe(
      'select * from "posts" order by "publishedAt" asc nulls last, "id" asc nulls last',
    );
    expect(ids(await source.execute())).toEqual(['x', 'y']);
  });

  test('leaves a plain read exactly the statement it asked for', async () => {
    const source = from<Post>('posts', tied).orderBy('publishedAt');
    expect(source.toSQL().sql).toBe('select * from "posts" order by "publishedAt" asc nulls last');
    // Stable sort, so the tie keeps the order the rows arrived in — which is no order at all in
    // SQL. That is the divergence `total()` exists to close, not a guarantee.
    expect(ids(await source.execute())).toEqual(['y', 'x']);
  });

  test('does not double an ordering that already names id', () => {
    const source = from<Post>('posts', tied).orderBy('id', 'desc').total();
    expect(source.toSQL().sql).toBe('select * from "posts" order by "id" desc nulls first');
  });
});

/**
 * The bug this closes: `"publishedAt" > $1` is unknown for every draft, so page two stopped at
 * the first NULL and the rows after it were unreachable through the cursor.
 */
describe('page two does not stop at the first NULL', () => {
  test('an ascending seek reaches the NULLs the ordering puts after it', async () => {
    const source = feed()
      .orderBy('publishedAt')
      .seek({ key: ['2026-02-01'], id: 'b' }, 2);
    expect(source.toSQL().sql).toContain('("publishedAt" > $1 or "publishedAt" is null)');
    expect(ids(await source.execute())).toEqual(['c', 'd']);
  });

  test('the id tiebreak keeps its plain form — it can never be NULL', () => {
    const { sql } = feed()
      .orderBy('publishedAt')
      .seek({ key: ['2026-02-01'], id: 'b' }, 2)
      .toSQL();
    expect(sql).toContain('"id" > $');
    expect(sql).not.toContain('"id" is null');
  });

  test('a NULL cursor value drops its own term and continues on the tiebreak', async () => {
    const source = feed()
      .orderBy('publishedAt')
      .seek({ key: [null], id: 'c' }, 2);
    // Nothing sorts after a NULL under `nulls last`, so `"publishedAt" > null` is not emitted.
    expect(source.toSQL()).toEqual({
      sql:
        'select * from "posts" where (("publishedAt" is null and "id" > $1))' +
        ' order by "publishedAt" asc nulls last, "id" asc nulls last limit 2',
      params: ['c'],
    });
    expect(ids(await source.execute())).toEqual(['d']);
  });

  test('a descending seek from a NULL cursor hands back every row that has a value', async () => {
    const source = feed()
      .orderBy('publishedAt', 'desc')
      .seek({ key: [null], id: 'c' }, 10);
    const { sql } = source.toSQL();
    expect(sql).toContain('("publishedAt" is not null)');
    expect(sql).toContain('("publishedAt" is null and "id" > $1)');
    expect(ids(await source.execute())).toEqual(['d', 'b', 'a']);
  });

  test('every row is paged exactly once across the NULL boundary', async () => {
    const page = (after: { key: readonly unknown[]; id: string } | null): Promise<Post[]> =>
      feed().orderBy('publishedAt').seek(after, 2).execute() as Promise<Post[]>;

    const first = await page(null);
    const second = await page({ key: [first[1]?.publishedAt ?? null], id: first[1]?.id ?? '' });
    const third = await page({ key: [second[1]?.publishedAt ?? null], id: second[1]?.id ?? '' });

    const seen = [...ids(first), ...ids(second), ...ids(third)];
    expect(seen).toEqual(['a', 'b', 'c', 'd']);
    expect(new Set(seen).size).toBe(seen.length);
  });

  test('a cursor past the end of an ascending listing selects nothing, not everything', async () => {
    // Only reachable from a hand-built cursor, and `()` would be a syntax error.
    const source = feed()
      .orderBy('publishedAt')
      .orderBy('id')
      .seek({ key: [null, null], id: 'x' }, 2);
    expect(source.toSQL().sql).toContain('where 1 = 0');
    expect(await source.execute()).toEqual([]);
  });
});

/** The fallback `paginate()` uses when a source cannot push the seek down. One "after", two paths. */
describe('isAfterKey answers what the SQL answers', () => {
  test('a NULL row follows a value under `asc`', () => {
    expect(isAfterKey({ id: 'c', publishedAt: null }, { key: ['2026-02-01'], id: 'b' }, ASC)).toBe(
      true,
    );
  });

  test('nothing with a value follows a NULL under `asc`', () => {
    expect(isAfterKey({ id: 'a', publishedAt: '2026-01-01' }, { key: [null], id: 'c' }, ASC)).toBe(
      false,
    );
  });

  test('every value follows a NULL under `desc`, and no NULL follows a value', () => {
    expect(isAfterKey({ id: 'b', publishedAt: '2026-02-01' }, { key: [null], id: 'c' }, DESC)).toBe(
      true,
    );
    expect(isAfterKey({ id: 'c', publishedAt: null }, { key: ['2026-02-01'], id: 'b' }, DESC)).toBe(
      false,
    );
  });

  test('two NULLs tie, so the id decides', () => {
    expect(isAfterKey({ id: 'd', publishedAt: null }, { key: [null], id: 'c' }, ASC)).toBe(true);
    expect(isAfterKey({ id: 'c', publishedAt: null }, { key: [null], id: 'd' }, ASC)).toBe(false);
  });
});

// `execute()` awaits whatever the provider returns, so all three spellings are one contract.
// `RowProvider` declared only the promise, which refused a synchronous provider the
// implementation has always run — a repo method holding its page already, and every fixture.
describe('a row provider may be a list, a sync function or an async one', () => {
  const expected = ['a', 'b', 'c', 'd'];

  test('a list', async () => {
    expect(ids(await from<Post>('posts', posts).orderBy('id').execute())).toEqual(expected);
  });

  test('a synchronous function', async () => {
    expect(
      ids(
        await from<Post>('posts', () => posts)
          .orderBy('id')
          .execute(),
      ),
    ).toEqual(expected);
  });

  test('an async function', async () => {
    const rows = await from<Post>('posts', async () => posts)
      .orderBy('id')
      .execute();
    expect(ids(rows)).toEqual(expected);
  });

  test('the provider is re-read per execute, so a later row is served', async () => {
    const live: Post[] = [];
    const source = from<Post>('posts', () => live).orderBy('id');
    expect(ids(await source.execute())).toEqual([]);
    live.push({ id: 'z', orgId: ORG, publishedAt: null, score: 1 });
    expect(ids(await source.execute())).toEqual(['z']);
  });
});
