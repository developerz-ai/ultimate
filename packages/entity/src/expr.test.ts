// One declaration, two enforcement points — so this file only ever asserts the two together. A
// rule the app accepts and the CHECK refuses is not a stricter database, it is a row that reaches
// Postgres as a raw constraint error instead of `X_INVARIANT_VIOLATED`.

import { afterAll, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { oneOf } from './column-values';
import { text } from './columns';
import { iff, invariantColumns } from './expr';
import { clearRegistry } from './registry';

afterAll(() => {
  clearRegistry();
});

// `C` supplied, exactly as `entity()` supplies it at `entity.ts:169`. Left to infer, `C` falls back
// to its `ColumnMap` constraint — an index signature — so `c.slug` was a possibly-`undefined`
// `ColumnExpr` reached through a string key, which is the shape `InvariantColumns<C>` was made a
// mapped type to stop being. The runtime list is `Object.keys` of the same map, so a column can
// never be declared to one half and not the other.
const columns = { slug: text(), title: text() };
const c = invariantColumns<typeof columns>('expr_test_posts', Object.keys(columns));
/** Physical names are the entity's job; here the property name IS the column. */
const resolve = (path: readonly string[]): string => path.join('_');

const codeOf = (build: () => unknown): string => {
  try {
    build();
    return 'resolved';
  } catch (error) {
    return isUltimateError(error) ? error.code : String(error);
  }
};

describe('matches(/…/) reaches the database with its flags, or not at all', () => {
  test('a case-insensitive pattern compiles to ~*, so both halves accept the same row', () => {
    const rule = c.slug.matches(/^[A-Z]+$/i);
    expect(rule.holds({ slug: 'abc' })).toBe(true);
    // `~` is case-SENSITIVE in Postgres: the old emission rejected the row `holds` had approved.
    expect(rule.toSql(resolve)).toBe("slug ~* '^[A-Z]+$'");
  });

  test('a plain pattern still compiles to ~', () => {
    expect(c.slug.matches(/^[a-z]+$/).toSql(resolve)).toBe("slug ~ '^[a-z]+$'");
  });

  test('a flag Postgres has no operator for is refused where the rule is written', () => {
    // Not "emitted without it": `/^a$/m` means something different line by line, and a CHECK that
    // silently drops it is the same disagreement one flag along.
    for (const pattern of [/^a$/m, /a/s, /a/gi, /a/u, /a/y]) {
      expect(codeOf(() => c.slug.matches(pattern))).toBe('X_INVARIANT_VIOLATED');
    }
  });

  test('a JS predicate is still app-only and still reports no SQL', () => {
    const rule = c.slug.matches((value) => value.startsWith('x'));
    expect(rule.toSql(resolve)).toBeNull();
    expect(rule.holds({ slug: 'xy' })).toBe(true);
  });
});

describe('minLength counts what Postgres counts', () => {
  test('an astral character is ONE character in both halves', () => {
    // `char_length('👍')` is 1 in Postgres; `'👍'.length` is 2 in JS. The old predicate approved a
    // row the CHECK then refused, so the framework's own invariant was bypassed on the way out.
    const rule = c.title.minLength(2);
    expect(rule.toSql(resolve)).toBe('char_length(title) >= 2');
    expect(rule.holds({ title: '👍' })).toBe(false);
    expect(rule.holds({ title: '👍👍' })).toBe(true);
    expect(rule.holds({ title: 'ab' })).toBe(true);
  });

  test('a combining sequence counts its code points, exactly as char_length does', () => {
    // `char_length('é')` for `e` + U+0301 is 2 — Postgres counts characters, not graphemes, and so
    // does this. Agreeing with the database beats agreeing with a human's idea of a letter.
    expect(c.title.minLength(2).holds({ title: 'é' })).toBe(true);
  });
});

describe('a null test is total on both sides — the first member of the vocabulary that is', () => {
  test('isNull and isNotNull emit the SQL Postgres has for exactly this question', () => {
    expect(c.title.isNull().toSql(resolve)).toBe('title is null');
    expect(c.title.isNotNull().toSql(resolve)).toBe('title is not null');
  });

  test('an ABSENT column and an explicit null are one row, exactly as they are to the table', () => {
    // The rule `memory-match.ts` has always applied to a predicate: a column the caller never named
    // holds NULL in the table whether it was spelled out or omitted, so a `===` here would make the
    // two rows different and judge a write by which keys the caller happened to type.
    expect(c.title.isNull().holds({})).toBe(true);
    expect(c.title.isNull().holds({ title: null })).toBe(true);
    expect(c.title.isNull().holds({ title: undefined })).toBe(true);
    expect(c.title.isNull().holds({ title: '' })).toBe(false);
    expect(c.title.isNotNull().holds({})).toBe(false);
    expect(c.title.isNotNull().holds({ title: null })).toBe(false);
    expect(c.title.isNotNull().holds({ title: '' })).toBe(true);
  });

  test('neither can answer NULL in SQL, which is what makes them usable inside iff', async () => {
    // Postgres' `IS NULL` is total by definition: it answers true or false for every input,
    // including NULL. Every other operator in this language answers NULL for a NULL operand, and a
    // CHECK PASSES on NULL — see the pinned disagreement below.
    expect(c.title.isNull().toSql(resolve)).not.toContain('=');
  });
});

describe('iff is the biconditional, and it is one node in both halves', () => {
  const coherent = iff(c.title.eq('published'), c.slug.isNotNull());

  test('it renders (a) = (b), which is what Postgres spells a biconditional as', () => {
    // Byte for byte the shape `examples/dummy`'s hand-written `0001_init.sql:67` already holds:
    // `(status = 'published') = (published_at IS NOT NULL)`.
    expect(coherent.toSql(resolve)).toBe("(title = 'published') = (slug is not null)");
  });

  test('the truth table is both-or-neither, and it is the SAME table on both sides', () => {
    expect(coherent.holds({ title: 'published', slug: 'x' })).toBe(true);
    expect(coherent.holds({ title: 'draft', slug: null })).toBe(true);
    expect(coherent.holds({ title: 'published', slug: null })).toBe(false);
    expect(coherent.holds({ title: 'draft', slug: 'x' })).toBe(false);
  });

  test('it names every column either side reads, once', () => {
    expect(coherent.paths).toEqual([['title'], ['slug']]);
    expect(iff(c.title.isNull(), c.title.isNotNull()).paths).toEqual([['title']]);
  });

  test('an app-only operand makes the whole rule app-only, never half a CHECK', () => {
    // `(null) = (slug is not null)` is not a predicate. The rule still RUNS, reports `sql: null`
    // and lands as `kind: 'assert'` through `bindInvariant` — which is the honest answer, and the
    // one `x verify` warns about.
    const partial = iff(
      c.title.matches((value) => value.length > 2),
      c.slug.isNotNull(),
    );
    expect(partial.toSql(resolve)).toBeNull();
    expect(partial.holds({ title: 'abcd', slug: 'x' })).toBe(true);
    expect(partial.holds({ title: 'ab', slug: 'x' })).toBe(false);
  });

  test('a unique operand is refused where it is written: it is a column list, not a predicate', () => {
    expect(codeOf(() => iff(c.unique(['title']), c.slug.isNotNull()))).toBe('X_INVARIANT_VIOLATED');
    expect(codeOf(() => iff(c.slug.isNotNull(), c.unique(['title'])))).toBe('X_INVARIANT_VIOLATED');
  });

  /**
   * PINNED, not fixed. `=` between two booleans is NULL when either operand is, and a CHECK PASSES
   * on NULL — so a partial operand makes the database MORE PERMISSIVE than the app, never less.
   * That is the direction this whole file exists to protect: the app refuses the row first, so no
   * write ever reaches Postgres as a raw `23514` the caller was owed `X_INVARIANT_VIOLATED` for.
   *
   * `is not distinct from` is the total form and is measurably WORSE here: it answers false for a
   * NULL operand, so `(NULL) is not distinct from (false)` refuses a row TypeScript accepts — the
   * dangerous direction, on the row nobody would think to test.
   */
  test('a partial operand leaves the CHECK permissive, and that is the safe direction', () => {
    const partial = iff(c.title.eq('published'), c.slug.isNotNull());
    // TypeScript reads an absent `title` as false, so both-or-neither refuses this row...
    expect(partial.holds({ slug: 'x' })).toBe(false);
    // ...while the SQL it emits leaves `title = 'published'` NULL, and `(NULL) = (true)` is NULL,
    // which a CHECK accepts. Asserted here so a change that flips the direction fails loudly.
    expect(partial.toSql(resolve)).toBe("(title = 'published') = (slug is not null)");
    expect(partial.toSql(resolve)).not.toContain('is not distinct from');
  });
});

describe('every declared string reaches SQL through @ultimat3/db, never a local quote', () => {
  /**
   * The adoption's own contract, and the half `sql-literal-copies` cannot see. That ratchet refuses
   * a module that RE-SPELLS the escape; nothing stops a producer from dropping the call entirely
   * (`` `'${value}'` `` doubles no quote, so it matches no rule). These four are every place this
   * package splices a declared string into statement text — an app's `enumerated()` member, a
   * `contains()` needle, an `eq()` operand and a `matches()` source — so a fifth added without the
   * call fails here.
   *
   * Correctness of the escape itself is `@ultimat3/db`'s to prove and is not restated.
   */
  test('a quote is doubled by all four producers', () => {
    const hazard = "'; drop table t; --";
    expect(c.slug.contains(hazard).toSql(resolve)).toBe(
      "position('''; drop table t; --' in slug) > 0",
    );
    expect(c.slug.eq(hazard).toSql(resolve)).toBe("slug = '''; drop table t; --'");
    expect(c.slug.matches(/^a'b$/).toSql(resolve)).toBe("slug ~ '^a''b$'");
    expect(oneOf([hazard, 'plain'])('status')).toBe("status in ('''; drop table t; --', 'plain')");
  });

  test("a backslash forces E'' by all four, which is the half a doubled quote misses", () => {
    expect(c.slug.contains('C:\\logs').toSql(resolve)).toBe("position(E'C:\\\\logs' in slug) > 0");
    expect(c.slug.eq('C:\\logs').toSql(resolve)).toBe("slug = E'C:\\\\logs'");
    expect(c.slug.matches(/^\d+$/).toSql(resolve)).toBe("slug ~ E'^\\\\d+$'");
    expect(oneOf(['C:\\logs'])('path')).toBe("path in (E'C:\\\\logs')");
  });

  test('a value with no backslash keeps the plain form, byte for byte', () => {
    // Both tracked apps have applied migrations on disk whose checksums are taken over this text.
    expect(c.slug.matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).toSql(resolve)).toBe(
      "slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'",
    );
    expect(oneOf(['draft', 'published', 'archived'])('status')).toBe(
      "status in ('draft', 'published', 'archived')",
    );
  });

  test('a non-string operand carries no quotes at all', () => {
    expect(c.slug.eq(0).toSql(resolve)).toBe('slug = 0');
    expect(c.slug.eq(10n).toSql(resolve)).toBe('slug = 10');
    expect(c.slug.eq(true).toSql(resolve)).toBe('slug = true');
  });
});
