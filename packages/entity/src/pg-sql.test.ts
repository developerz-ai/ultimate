// Single responsibility: pin `pg-sql.ts` directly — the statement compiler both entity drivers'
// tests exercise only indirectly, through `postgresRepo()` and a recording client. Testing the
// builders here, against the `SqlFragment` they return, catches a drift in *how* a plan becomes
// SQL without a driver, a registry-backed entity's full column machinery, or a database in the
// way — the exact seam `packages/entity/CLAUDE.md` names as where the two drivers must agree.

import { afterAll, describe, expect, test } from 'bun:test';
import { boolean, money, text, timestamp, uuid } from './columns';
import { entity } from './entity';
import { countByStatement, countStatement, selectStatement } from './pg-sql';
import { deleteStatement, insertStatement, updateStatement } from './pg-write-sql';
import { clearRegistry } from './registry';
import type { Predicate, QueryPlan } from './tenancy';

const posts = entity('pgsql_posts', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid().tenant(),
    title: text(),
    published: boolean().default(false),
    deletedAt: timestamp().nullable(),
  },
});

/** No soft-delete column, so `conditions()` never injects the `deleted_at is null` clause. */
const tags = entity('pgsql_tags', {
  columns: { id: uuid().primaryKey(), label: text() },
});

const priced = entity('pgsql_priced', {
  columns: { id: uuid().primaryKey(), amount: money() },
});

afterAll(() => {
  clearRegistry();
});

const planOf = (over: Partial<QueryPlan> = {}): QueryPlan => ({
  entity: posts.$name,
  where: [],
  orderBy: [{ column: 'id', direction: 'asc' }],
  limit: 50,
  ...over,
});

const SHAPE = { includeDeleted: false } as const;

describe('predicateSql, via selectStatement', () => {
  // countStatement carries a predicate through `conditions()` with no trailing `limit` value to
  // account for, so `.values` reflects the predicate alone.
  const where = (predicate: Predicate) =>
    countStatement(posts, planOf({ where: [predicate] }), SHAPE);

  test('eq with a null value renders "is null", not "= $n" — NULL never equals a bound param', () => {
    const stmt = where({ column: 'title', op: 'eq', value: null });
    expect(stmt.text).toContain('"title" is null');
    expect(stmt.values).not.toContain(null);
  });

  test('eq with a real value binds it', () => {
    const stmt = where({ column: 'title', op: 'eq', value: 'hi' });
    expect(stmt.text).toContain('"title" = $');
    expect(stmt.values).toContain('hi');
  });

  test('neq renders "is distinct from" so a null on either side compares as a value', () => {
    const stmt = where({ column: 'title', op: 'neq', value: 'hi' });
    expect(stmt.text).toContain('"title" is distinct from $');
  });

  test('in with an empty array becomes the NEVER constant, not a syntax error', () => {
    const stmt = where({ column: 'title', op: 'in', value: [] });
    expect(stmt.text).toContain('1 = 0');
    expect(stmt.text).not.toContain('"title" in');
  });

  test('in with values renders one placeholder per value, in order', () => {
    const stmt = where({ column: 'title', op: 'in', value: ['a', 'b', 'c'] });
    expect(stmt.text).toContain('"title" in (');
    expect(stmt.values).toEqual(['a', 'b', 'c']);
  });

  // `in` reads a list or nothing. Wrapping a scalar matched a row here that `memoryRepo`'s
  // `matches` refuses outright — 0 rows in memory, 1 in Postgres — and `andWhere(column, op,
  // value: unknown)` compiles, so the mistake is reachable. `@ultimat3/query` answers no rows for
  // the same operand; this is the two drivers and the two packages giving one answer.
  test('in with a scalar (not an array) matches nothing, as it does in memory', () => {
    const stmt = where({ column: 'title', op: 'in', value: 'solo' });
    expect(stmt.text).toContain('1 = 0');
    expect(stmt.text).not.toContain('"title" in');
    expect(stmt.values).toEqual([]);
  });

  // `col in ($1)` with a NULL bound is `col = null`, which is UNKNOWN: the null row the caller
  // listed is the one row Postgres leaves out, while memory's `sameValue(null, null)` includes it.
  test('in with a null in the list asks for the nulls separately', () => {
    const stmt = where({ column: 'title', op: 'in', value: ['a', null] });
    expect(stmt.text).toContain('"title" in (');
    expect(stmt.text).toContain('or "title" is null');
    expect(stmt.values).toEqual(['a']);
  });

  test('in with nothing but nulls is "is null" alone, never a bound parameter', () => {
    const stmt = where({ column: 'title', op: 'in', value: [null] });
    expect(stmt.text).toContain('"title" is null');
    expect(stmt.text).not.toContain('"title" in');
    expect(stmt.values).toEqual([]);
  });

  test.each([
    ['gt', '>'],
    ['gte', '>='],
    ['lt', '<'],
    ['lte', '<='],
    ['like', 'like'],
  ] as const)('%s renders "%s"', (op, token) => {
    const stmt = where({ column: 'title', op, value: 'x' });
    expect(stmt.text).toContain(`"title" ${token} $`);
  });

  // The Postgres half of `memory-match.test.ts`'s NULL table, provable without a server: the five
  // ordering operators emit a BARE comparison, so a NULL on either side is UNKNOWN and the row is
  // never returned. `eq`, `neq` and `in` are the three that read a NULL as a value, and they are
  // the three that carry `is null` / `is distinct from` — which is exactly why the memory driver
  // guards those five and not these three.
  test.each(['gt', 'gte', 'lt', 'lte', 'like'] as const)(
    '%s never widens itself with "is null" — a NULL row is unreachable in Postgres',
    (op) => {
      // Named per column: the statement always carries the soft-delete `"deleted_at" is null`.
      const stmt = where({ column: 'title', op, value: 'x' });
      expect(stmt.text).not.toContain('"title" is null');
      expect(stmt.text).not.toContain('"title" is distinct from');
    },
  );

  test('is-null and is-not-null bind nothing', () => {
    expect(where({ column: 'title', op: 'is-null' }).text).toContain('"title" is null');
    expect(where({ column: 'title', op: 'is-not-null' }).text).toContain('"title" is not null');
    expect(where({ column: 'title', op: 'is-null' }).values).toEqual([]);
  });

  test('a property is resolved through the entity to its physical, snake_case column', () => {
    const stmt = where({ column: 'orgId', op: 'eq', value: '1' });
    expect(stmt.text).toContain('"org_id"');
    expect(stmt.text).not.toContain('"orgId"');
  });
});

describe('conditions()', () => {
  test('no predicates and no soft delete compiles to a bare "true"', () => {
    const stmt = selectStatement(tags, planOf({ entity: tags.$name, where: [] }), SHAPE, 50);
    expect(stmt.text).toContain('where true');
  });

  test('a soft-deleting entity gets "deleted_at is null" appended unless includeDeleted', () => {
    const hidden = selectStatement(posts, planOf(), SHAPE, 50);
    expect(hidden.text).toContain('"deleted_at" is null');

    const shown = selectStatement(posts, planOf(), { includeDeleted: true }, 50);
    expect(shown.text).not.toContain('"deleted_at" is null');
  });

  test('multiple predicates and the soft-delete clause join with "and"', () => {
    const stmt = selectStatement(
      posts,
      planOf({ where: [{ column: 'title', op: 'eq', value: 't' }] }),
      SHAPE,
      50,
    );
    expect(stmt.text).toMatch(/"title" = \$1 and "deleted_at" is null/);
  });
});

describe('seekSql via selectStatement', () => {
  test('a single sort key seeks with a strict comparison in the sort direction', () => {
    const stmt = selectStatement(
      tags,
      planOf({ entity: tags.$name, orderBy: [{ column: 'id', direction: 'asc' }] }),
      { includeDeleted: false, seek: ['last-id'] },
      50,
    );
    expect(stmt.text).toContain('"id" > $');
    expect(stmt.values).toContain('last-id');
  });

  test('desc order seeks with "<", not ">"', () => {
    const stmt = selectStatement(
      tags,
      planOf({ entity: tags.$name, orderBy: [{ column: 'id', direction: 'desc' }] }),
      { includeDeleted: false, seek: ['last-id'] },
      50,
    );
    expect(stmt.text).toContain('"id" < $');
  });

  test('a multi-key order seeks with the row-comparison expansion, not a tuple comparison', () => {
    // Through `selectStatement`, never `countStatement`: a seek is pagination, and pagination is
    // exactly what an aggregate must ignore — a count that dropped the rows before the cursor
    // would answer "how many are left on this page", which is not what `count()` means.
    const stmt = selectStatement(
      posts,
      planOf({
        orderBy: [
          { column: 'title', direction: 'desc' },
          { column: 'id', direction: 'asc' },
        ],
      }),
      { includeDeleted: false, seek: ['t0', 'id0'] },
      50,
    );
    // (title < $a) or (title = $b and id > $c) — never "(title, id) > (...)", which requires
    // every key to sort the same way and this order does not.
    expect(stmt.text).toContain('"title" < $');
    expect(stmt.text).toMatch(/"title" = \$\d+ and "id" > \$\d+/);
    // The cursor values are the leading params and the page limit is the last one, asserted apart
    // so this case stays about the seek expansion rather than the statement's whole binding list.
    expect(stmt.values.slice(0, 3)).toEqual(['t0', 't0', 'id0']);
    expect(stmt.values.at(-1)).toBe(50);
  });
});

describe('orderSql / selectStatement shape', () => {
  test('order by renders every sort key with its direction, comma-joined', () => {
    const stmt = selectStatement(
      posts,
      planOf({
        orderBy: [
          { column: 'title', direction: 'desc' },
          { column: 'id', direction: 'asc' },
        ],
      }),
      SHAPE,
      50,
    );
    // NULL's place is written down rather than inherited: `asc nulls last`, `desc nulls first`,
    // the spelling `@ultimat3/query` already used. A driver whose default differs cannot reopen it.
    expect(stmt.text).toContain('order by "title" desc nulls first, "id" asc nulls last');
  });

  test('limit is bound as a value, not spliced into the text', () => {
    const stmt = selectStatement(posts, planOf(), SHAPE, 7);
    expect(stmt.values.at(-1)).toBe(7);
  });
});

describe('projection', () => {
  test('no select projects every physical column, money split into two', () => {
    const stmt = selectStatement(priced, planOf({ entity: priced.$name, where: [] }), SHAPE, 50);
    expect(stmt.text).toContain('"amount_minor"');
    expect(stmt.text).toContain('"amount_currency"');
  });

  test('a select list is widened with the primary key and the sort keys', () => {
    const stmt = selectStatement(
      posts,
      planOf({ select: ['title'], orderBy: [{ column: 'id', direction: 'asc' }] }),
      SHAPE,
      50,
    );
    // Only "title" was asked for, but "id" (primary key + sort key) rides along so the page can
    // mint a cursor — orgId and published were never named and stay absent.
    expect(stmt.text).toContain('"title"');
    expect(stmt.text).toContain('"id"');
    expect(stmt.text).not.toContain('"org_id"');
    expect(stmt.text).not.toContain('"published"');
  });

  test('a select naming an unknown property is dropped rather than crashing the query', () => {
    const stmt = selectStatement(posts, planOf({ select: ['title', 'nonexistent'] }), SHAPE, 50);
    expect(stmt.text).toContain('"title"');
    expect(stmt.text).not.toContain('nonexistent');
  });
});

describe('countStatement', () => {
  test('counts the same rows a select would, with no projection or order', () => {
    const stmt = countStatement(posts, planOf(), SHAPE);
    expect(stmt.text).toContain('select count(*) as count from "pgsql_posts"');
    expect(stmt.text).toContain('"deleted_at" is null');
    expect(stmt.text).not.toContain('order by');
  });
});

describe('countByStatement', () => {
  test('groups by the named column with fixed, aliased output names', () => {
    const stmt = countByStatement(posts, planOf(), SHAPE, 'title', 100);
    expect(stmt.text).toContain('"title" as group_value');
    expect(stmt.text).toContain('count(*) as group_count');
    expect(stmt.text).toContain('group by "title"');
    expect(stmt.values.at(-1)).toBe(100);
  });
});

describe('insertStatement', () => {
  test('one row compiles to exactly the text insert(row) always compiled to', () => {
    const stmt = insertStatement(posts, [new Map<string, unknown>([['title', 't1']])], {
      columns: ['title'],
    });
    expect(stmt.text).toBe('insert into "pgsql_posts" ("title") values ($1) returning *');
    expect(stmt.values).toEqual(['t1']);
  });

  test('many rows compile to one statement, one tuple per row', () => {
    const rows = [
      new Map<string, unknown>([['title', 'a']]),
      new Map<string, unknown>([['title', 'b']]),
    ];
    const stmt = insertStatement(posts, rows, { columns: ['title'] });
    expect(stmt.text).toContain('values ($1), ($2)');
    expect(stmt.values).toEqual(['a', 'b']);
  });

  test('a row missing a column gets the "default" cell, not a bound null', () => {
    const rows = [
      new Map<string, unknown>([
        ['title', 'a'],
        ['published', true],
      ]),
      new Map<string, unknown>([['title', 'b']]),
    ];
    const stmt = insertStatement(posts, rows, { columns: ['title', 'published'] });
    expect(stmt.text).toContain('($1, $2), ($3, default)');
    expect(stmt.values).toEqual(['a', true, 'b']);
  });

  test('no conflict target means a bare insert, no "on conflict" clause', () => {
    const stmt = insertStatement(posts, [new Map([['title', 'a']])], { columns: ['title'] });
    expect(stmt.text).not.toContain('on conflict');
  });

  test('an empty set list compiles to "do nothing"', () => {
    const stmt = insertStatement(posts, [new Map([['title', 'a']])], {
      columns: ['title'],
      conflict: { columns: ['id'], set: [] },
    });
    expect(stmt.text).toContain('on conflict ("id") do nothing');
  });

  test('a non-empty set list compiles to "do update set" against excluded, per column', () => {
    const stmt = insertStatement(posts, [new Map([['title', 'a']])], {
      columns: ['title'],
      conflict: { columns: ['id'], set: ['title', 'published'] },
    });
    expect(stmt.text).toContain(
      'on conflict ("id") do update set "title" = excluded."title", "published" = excluded."published"',
    );
  });
});

describe('updateStatement', () => {
  test('sets every named column and returns the row, scoped by the same conditions as a read', () => {
    const stmt = updateStatement(
      posts,
      planOf({ where: [{ column: 'id', op: 'eq', value: 'p1' }] }),
      new Map<string, unknown>([['title', 't2']]),
      SHAPE,
      true,
    );
    expect(stmt.text).toContain('update "pgsql_posts" set "title" = $1');
    expect(stmt.text).toContain('where "id" = $2 and "deleted_at" is null');
    expect(stmt.text).toContain('returning *');
    expect(stmt.values).toEqual(['t2', 'p1']);
  });

  // The failure case first: a caller that reads a COUNT must not be handed the rows anyway. A
  // filtered write over a whole tenant is the one statement here whose result set is the caller's
  // filter rather than a page, so `returning *` there is a table crossing the wire for nobody.
  test('returning: false writes the same rows and names none of them', () => {
    const same = (returning: boolean): string =>
      updateStatement(
        posts,
        planOf({ where: [{ column: 'id', op: 'eq', value: 'p1' }] }),
        new Map<string, unknown>([['title', 't2']]),
        SHAPE,
        returning,
      ).text;
    expect(same(false)).not.toContain('returning');
    // Identical up to the clause, so the two are one statement and not two builders.
    expect(`${same(false)} returning *`).toBe(same(true));
  });
});

describe('deleteStatement', () => {
  test('always includes soft-deleted rows in its own scope — there is no filter left to apply', () => {
    const stmt = deleteStatement(
      posts,
      planOf({ where: [{ column: 'id', op: 'eq', value: 'p1' }] }),
    );
    expect(stmt.text).toContain('delete from "pgsql_posts" where "id" = $1');
    expect(stmt.text).not.toContain('deleted_at');
  });

  test('an entity with no soft-delete column needs no special-casing here either', () => {
    const stmt = deleteStatement(tags, {
      entity: tags.$name,
      where: [{ column: 'id', op: 'eq', value: 't1' }],
      orderBy: [],
      limit: 1,
    });
    expect(stmt.text).toBe('delete from "pgsql_tags" where "id" = $1');
  });
});
