// What a predicate MEANS in the in-memory driver, asserted against what Postgres means by the same
// predicate on the same column. Every case here is a place the two drivers used to disagree, so the
// bar is `entity/CLAUDE.md`'s "two drivers, one meaning" and not the memory driver's own taste:
// the ordering of a decimal-string column, the case of a `uuid`, and what a `\` does inside a LIKE.

import { afterAll, describe, expect, test } from 'bun:test';
import { text, uuid } from './columns';
import { bigint, decimal } from './columns-data';
import { entity } from './entity';
import { clearRegistry } from './registry';
import { memoryRepo } from './repo';

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
