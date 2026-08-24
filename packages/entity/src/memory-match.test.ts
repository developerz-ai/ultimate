// What a predicate MEANS in the in-memory driver, asserted against what Postgres means by the same
// predicate on the same column. Every case here is a place the two drivers used to disagree, so the
// bar is `entity/CLAUDE.md`'s "two drivers, one meaning" and not the memory driver's own taste:
// the ordering of a decimal-string column, the case of a `uuid`, and what a `\` does inside a LIKE.

import { afterAll, describe, expect, test } from 'bun:test';
import { integer, money, text, uuid } from './columns';
import { bigint, decimal } from './columns-data';
import { entity } from './entity';
import { memoryRepo } from './memory-repo';
import { clearRegistry } from './registry';
import type { Predicate } from './tenancy';

const ledger = entity('match_test_ledger', {
  columns: {
    id: uuid().primaryKey(),
    /** `int8`, whose ROW VALUE is a decimal string — the type no `typeof` branch catches. */
    seq: bigint(),
    /** `numeric`, the same shape with a fraction. */
    rate: decimal({ precision: 12, scale: 4 }),
    label: text({ max: 40 }),
  },
});

type Ledger = typeof ledger.$row;

/** Hex LETTERS on purpose: an id of digits alone has no case for `toUpperCase()` to change. */
const idAt = (index: number): string => `00000000-0000-7000-8000-0000000000a${String(index)}`;

/** Digits chosen so text order and numeric order disagree on every pair. */
const SEQS = ['2', '9', '10', '100'] as const;

const seeded = () => {
  const repo = memoryRepo(ledger);
  return {
    repo,
    ready: Promise.all(
      SEQS.map((seq, index) =>
        repo.insert({
          id: idAt(index + 1),
          seq,
          rate: `${seq}.5000`,
          label: `row-${seq}`,
        } as Ledger),
      ),
    ),
  };
};

afterAll(() => {
  clearRegistry();
});

describe('a decimal-string column orders by its digits, as the database does', () => {
  test('bigint sorts numerically, never as text', async () => {
    const { repo, ready } = seeded();
    await ready;

    const page = await repo.findMany({ orderBy: [{ column: 'seq', direction: 'asc' }] });

    expect(page.rows.map((row) => row.seq)).toEqual(['2', '9', '10', '100']);
  });

  test('numeric sorts numerically too, fraction included', async () => {
    const { repo, ready } = seeded();
    await ready;

    const page = await repo.findMany({ orderBy: [{ column: 'rate', direction: 'desc' }] });

    expect(page.rows.map((row) => row.rate)).toEqual(['100.5000', '10.5000', '9.5000', '2.5000']);
  });

  test('a comparison predicate compares the same way the sort does', async () => {
    const { repo, ready } = seeded();
    await ready;

    const above = await repo.findMany({
      where: [{ column: 'seq', op: 'gt', value: '9' }],
      orderBy: [{ column: 'seq', direction: 'asc' }],
    });

    // As text, none of `2`, `10` or `100` is greater than `9` — so this page used to be empty.
    expect(above.rows.map((row) => row.seq)).toEqual(['10', '100']);
  });

  // A keyset cursor revives its value from the column's kind (`cursor.ts`), so the seek compares a
  // stored decimal STRING against a `BigInt`. Text order cut the page where Postgres never cuts
  // one: page two started with rows page one had already served, or skipped rows entirely.
  test('paging by that column serves every row exactly once, in order', async () => {
    const { repo, ready } = seeded();
    await ready;

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 6; page += 1) {
      const result = await repo.findMany({
        orderBy: [{ column: 'seq', direction: 'asc' }],
        limit: 2,
        cursor,
      });
      seen.push(...result.rows.map((row) => row.seq));
      cursor = result.nextCursor;
      if (cursor === null) break;
    }

    expect(cursor).toBeNull();
    expect(seen).toEqual(['2', '9', '10', '100']);
  });
});

describe('a uuid is a value, and its case is not part of it', () => {
  const UPPER = idAt(1).toUpperCase();

  test('findById reads the row whichever case the id is spelled in', async () => {
    const { repo, ready } = seeded();
    await ready;

    expect((await repo.findById(UPPER))?.label).toBe('row-2');
    expect((await repo.findById(idAt(1)))?.label).toBe('row-2');
  });

  test('update and delete address it too, instead of X_NOT_FOUND against a row that exists', async () => {
    const { repo, ready } = seeded();
    await ready;

    const written = await repo.update(UPPER, { label: 'renamed' } as Partial<Ledger>);
    expect(written.label).toBe('renamed');
    // One row, not two: the upper-cased write must land on the row already stored.
    expect(await repo.count()).toBe(SEQS.length);

    await repo.delete(UPPER);
    expect(await repo.findById(idAt(1))).toBeNull();
  });

  test('an `in` list matches it by value as well', async () => {
    const { repo, ready } = seeded();
    await ready;

    const found = await repo.findMany({ where: [{ column: 'id', op: 'in', value: [UPPER] }] });

    expect(found.rows.map((row) => row.label)).toEqual(['row-2']);
  });

  // A text key is compared by its bytes in Postgres, so lower-casing one would merge two rows the
  // database keeps apart — the reason `keyOf` narrows the `uuid` kind and nothing else.
  test('a text column keeps its case', async () => {
    const { repo, ready } = seeded();
    await ready;

    const found = await repo.findMany({ where: [{ column: 'label', op: 'eq', value: 'ROW-2' }] });

    expect(found.rows).toEqual([]);
  });
});

describe('a LIKE pattern means what it means in Postgres', () => {
  const like = async (pattern: string): Promise<readonly string[]> => {
    const repo = memoryRepo(ledger);
    await repo.insert({ id: idAt(1), seq: '1', rate: '1.0000', label: 'a%b' } as Ledger);
    await repo.insert({ id: idAt(2), seq: '2', rate: '2.0000', label: 'axxb' } as Ledger);
    await repo.insert({ id: idAt(3), seq: '3', rate: '3.0000', label: 'a\\b' } as Ledger);
    const found = await repo.findMany({
      where: [{ column: 'label', op: 'like', value: pattern }],
    });
    return found.rows.map((row) => row.label);
  };

  test('a backslash escapes the wildcard instead of matching one', async () => {
    // Postgres: `a\%b` matches the literal `a%b`. Escaping the backslash for the regex BEFORE the
    // wildcards were expanded made this `a\<anything>b` here — the opposite pattern.
    expect(await like('a\\%b')).toEqual(['a%b']);
    expect(await like('a%b')).toEqual(['a%b', 'axxb', 'a\\b']);
    expect(await like('a\\_b')).toEqual([]);
  });

  test('a doubled backslash matches one literal backslash', async () => {
    expect(await like('a\\\\b')).toEqual(['a\\b']);
  });

  test('a pattern ending in the escape character is refused, as Postgres refuses it (22025)', async () => {
    await expect(like('a\\')).rejects.toBeUltimateError('X_INVARIANT_VIOLATED');
  });

  test('a run of wildcards is still one wildcard', async () => {
    expect(await like('a%%%%b')).toEqual(['a%b', 'axxb', 'a\\b']);
  });
});

// `in` reads a list or nothing, in both drivers and in `@ultimat3/query`: the operand below used to
// be wrapped into a one-element list by `predicateSql` and refused here — 0 rows against memory,
// 1 against Postgres, from a call `andWhere(column, op, value: unknown)` compiles.
describe('an `in` operand that is not a list', () => {
  test('matches nothing', async () => {
    const { repo, ready } = seeded();
    await ready;

    const found = await repo.findMany({ where: [{ column: 'seq', op: 'in', value: '2' }] });

    expect(found.rows).toEqual([]);
  });
});

// A NULL on either side of an ordering operator is UNKNOWN in SQL, and UNKNOWN is not a match:
// `predicateSql` emits a bare `"col" > $1`, so Postgres never returns the NULL row. `compareByKind`
// fell through to `sign(String(left), String(right))` and `like` did `String(actual)`, so the row
// was compared as the TEXT `"null"` — measured: `gt seats 5` answered the null row, `like 'nu%'`
// matched it, and `lt seats null` answered every row. Green in memory, a miss in production.
//
// `eq`, `neq` and `in` are deliberately NOT guarded: those three compile to `is null` /
// `is distinct from`, which read a NULL as a value, and they are the only three that do.
describe('a NULL column, under every operator', () => {
  const nulls = entity('match_test_nulls', {
    columns: {
      id: uuid().primaryKey(),
      seats: integer().nullable(),
      title: text({ max: 40 }).nullable(),
    },
  });

  const EMPTY_ROW = idAt(1);
  const FULL_ROW = idAt(2);

  const seededNulls = () => {
    const repo = memoryRepo(nulls);
    return {
      repo,
      ready: Promise.all([
        repo.insert({ id: EMPTY_ROW, seats: null, title: null }),
        repo.insert({ id: FULL_ROW, seats: 5, title: 'nine' }),
      ]),
    };
  };

  const matching = async (where: Predicate): Promise<readonly string[]> => {
    const { repo, ready } = seededNulls();
    await ready;
    const found = await repo.findMany({ where: [where] });
    return found.rows.map((row) => row.id);
  };

  const ORDERING: readonly (readonly [string, Predicate, readonly string[]])[] = [
    // Observed before the guard: [EMPTY_ROW].
    ['gt over a number', { column: 'seats', op: 'gt', value: 5 }, []],
    // Observed before the guard: [EMPTY_ROW, FULL_ROW] — "null" sorts after "5" as text.
    ['gte over a number', { column: 'seats', op: 'gte', value: 5 }, [FULL_ROW]],
    // Observed before the guard: [EMPTY_ROW, FULL_ROW] — "null" sorts before "z".
    ['lt over text', { column: 'title', op: 'lt', value: 'z' }, [FULL_ROW]],
    ['lte over text', { column: 'title', op: 'lte', value: 'z' }, [FULL_ROW]],
    ['gt over text', { column: 'title', op: 'gt', value: 'a' }, [FULL_ROW]],
    ['gte over text', { column: 'title', op: 'gte', value: 'a' }, [FULL_ROW]],
    // The NULL on the OTHER side: `seats < null` is UNKNOWN for every row, the stored value
    // included. Observed before the guard: [FULL_ROW], because "5" sorts before "null".
    ['lt against a null operand', { column: 'seats', op: 'lt', value: null }, []],
    ['gte against a null operand', { column: 'seats', op: 'gte', value: null }, []],
  ];

  for (const [name, where, expected] of ORDERING) {
    test(`${name} never answers the NULL row`, async () => {
      expect(await matching(where)).toEqual(expected);
    });
  }

  test('like never matches the text "null"', async () => {
    // Observed before the guard: `nu%` answered [EMPTY_ROW] — the string `String(null)`.
    expect(await matching({ column: 'title', op: 'like', value: 'nu%' })).toEqual([]);
    expect(await matching({ column: 'title', op: 'like', value: 'n%' })).toEqual([FULL_ROW]);
    // A null PATTERN is UNKNOWN too, so it matches no row — not even the null one.
    expect(await matching({ column: 'title', op: 'like', value: null })).toEqual([]);
  });

  test('eq, neq and in still read a NULL as a value — they compile to `is null`', async () => {
    expect(await matching({ column: 'seats', op: 'eq', value: null })).toEqual([EMPTY_ROW]);
    expect(await matching({ column: 'seats', op: 'neq', value: 5 })).toEqual([EMPTY_ROW]);
    expect(await matching({ column: 'seats', op: 'in', value: [null] })).toEqual([EMPTY_ROW]);
    expect(await matching({ column: 'seats', op: 'in', value: [5] })).toEqual([FULL_ROW]);
    expect(await matching({ column: 'seats', op: 'is-null' })).toEqual([EMPTY_ROW]);
    expect(await matching({ column: 'seats', op: 'is-not-null' })).toEqual([FULL_ROW]);
  });
});

// A row that never NAMED a nullable column and a row that stored `null` in it are ONE row in
// Postgres: the column holds NULL either way, and `predicateSql` compiles `eq null` to
// `"col" is null`, which answers both. In memory the absent half is `undefined`, and this file
// already says so — `isNull` is `value === null || value === undefined`, and `is-null`,
// `is-not-null` and the ordering guard all read it. `eq`, `neq` and `in` did not: they compared
// with `===`, so the absent row was invisible to `eq null` and to `in [null]` while `neq null`
// answered it, each the opposite of what the same predicate does in production.
//
// Absent is reachable two ways, and the second needs no hand-built fixture at all: a `money()`
// column holding NULL has no `price.minor` to read, so `valueAt` answers `undefined` for a row
// `$parse` itself produced.
describe('a column the row never named is NULL, as it is in the table', () => {
  const absent = entity('match_test_absent', {
    columns: {
      id: uuid().primaryKey(),
      seats: integer().nullable(),
      price: money().nullable(),
    },
  });

  type Absent = typeof absent.$row;

  const NEVER_NAMED = idAt(1);
  const STORED_NULL = idAt(2);
  const VALUED = idAt(3);

  const seededAbsent = () => {
    const repo = memoryRepo(absent);
    return {
      repo,
      ready: Promise.all([
        // The repository seam takes the row as handed over — a seed, a fixture and every direct
        // `memoryRepo` caller reach it without `$parse`, so `seats` is simply not there.
        repo.insert({ id: NEVER_NAMED } as Absent),
        repo.insert({ id: STORED_NULL, seats: null, price: null } as Absent),
        repo.insert({ id: VALUED, seats: 5, price: { minor: 100, currency: 'EUR' } } as Absent),
      ]),
    };
  };

  const matching = async (where: Predicate): Promise<readonly string[]> => {
    const { repo, ready } = seededAbsent();
    await ready;
    const found = await repo.findMany({ where: [where] });
    return found.rows.map((row) => row.id);
  };

  test('eq null answers it, exactly as `"seats" is null` does', async () => {
    // Observed before the fix: [STORED_NULL] — the row that spelled the null out.
    expect(await matching({ column: 'seats', op: 'eq', value: null })).toEqual([
      NEVER_NAMED,
      STORED_NULL,
    ]);
  });

  test('neq null does NOT answer it: `is distinct from null` is false for a NULL column', async () => {
    // Observed before the fix: [NEVER_NAMED, VALUED] — `undefined !== null`, so the absent row
    // read as a value that differs from NULL.
    expect(await matching({ column: 'seats', op: 'neq', value: null })).toEqual([VALUED]);
  });

  test('in [null] answers it, exactly as the `or "seats" is null` half of the list does', async () => {
    expect(await matching({ column: 'seats', op: 'in', value: [null] })).toEqual([
      NEVER_NAMED,
      STORED_NULL,
    ]);
    expect(await matching({ column: 'seats', op: 'in', value: [5, null] })).toEqual([
      NEVER_NAMED,
      STORED_NULL,
      VALUED,
    ]);
  });

  test('a value still never matches the absent row', async () => {
    expect(await matching({ column: 'seats', op: 'eq', value: 5 })).toEqual([VALUED]);
    // `is distinct from 5` is TRUE for a NULL column, in both drivers.
    expect(await matching({ column: 'seats', op: 'neq', value: 5 })).toEqual([
      NEVER_NAMED,
      STORED_NULL,
    ]);
    expect(await matching({ column: 'seats', op: 'in', value: [5] })).toEqual([VALUED]);
  });

  test('a money part of a NULL money column is NULL too, and needs no hand-built row', async () => {
    // `price_minor` is NULL in the table for both of the first two rows, so `is null` answers
    // both — and `valueAt(row, "price.minor")` is `undefined` for both, whatever `$parse` did.
    expect(await matching({ column: 'price.minor', op: 'eq', value: null })).toEqual([
      NEVER_NAMED,
      STORED_NULL,
    ]);
    expect(await matching({ column: 'price.minor', op: 'eq', value: 100 })).toEqual([VALUED]);
  });
});
