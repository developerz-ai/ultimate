import { describe, expect, test } from 'bun:test';
import { isSqlFragment, join, literal, raw, sql } from './sql';
import { statementsOf } from './statement-split';

describe('sql', () => {
  test('binds values as $1..$n and never inlines them', () => {
    const fragment = sql`select * from posts where org_id = ${'org_1'} and likes > ${10}`;
    expect(fragment.text).toBe('select * from posts where org_id = $1 and likes > $2');
    expect(fragment.values).toEqual(['org_1', 10]);
    expect(fragment.text).not.toContain('org_1');
    expect(fragment.text).not.toContain('10');
  });

  test('a classic injection payload stays a single bound value', () => {
    const attack = "x'; drop table posts; --";
    const fragment = sql`select * from posts where slug = ${attack}`;
    expect(fragment.text).toBe('select * from posts where slug = $1');
    expect(fragment.values).toEqual([attack]);
    expect(fragment.text).not.toContain('drop table');
  });

  test('undefined is bound as null rather than the string "undefined"', () => {
    const fragment = sql`select ${undefined}`;
    expect(fragment.values).toEqual([null]);
  });

  test('an interpolated string that is not a fragment cannot smuggle SQL in', () => {
    const forged = { text: 'drop table posts', values: [] };
    expect(() => sql`select 1 ${forged}`).toThrow('X_SQL_UNSAFE');
    try {
      sql`select 1 ${forged}`;
    } catch (error) {
      expect((error as { code: string }).code).toBe('X_SQL_UNSAFE');
      expect((error as { cause: string }).cause).toContain('interpolation #1');
    }
  });

  test('functions and plain objects are rejected, not stringified', () => {
    expect(() => sql`select ${() => 'boom'}`).toThrow('X_SQL_UNSAFE');
    expect(() => sql`select ${{ a: 1 }}`).toThrow('X_SQL_UNSAFE');
  });

  test('nested fragments renumber their parameters', () => {
    const where = sql`org_id = ${'org_1'} and status = ${'draft'}`;
    const outer = sql`select * from posts where ${where} and likes > ${5}`;
    expect(outer.text).toBe('select * from posts where org_id = $1 and status = $2 and likes > $3');
    expect(outer.values).toEqual(['org_1', 'draft', 5]);
  });

  test('a fragment nested after a value renumbers from the current offset', () => {
    const inner = sql`b = ${'B'}`;
    const outer = sql`select where a = ${'A'} and ${inner} and c = ${'C'}`;
    expect(outer.text).toBe('select where a = $1 and b = $2 and c = $3');
    expect(outer.values).toEqual(['A', 'B', 'C']);
  });

  test('raw() is trusted and contributes no parameters', () => {
    const fragment = sql`select * from ${raw('x_migrations')} where id = ${'m1'}`;
    expect(fragment.text).toBe('select * from x_migrations where id = $1');
    expect(fragment.values).toEqual(['m1']);
    expect(isSqlFragment(raw('select 1'))).toBe(true);
    expect(isSqlFragment({ text: 'select 1', values: [] })).toBe(false);
  });

  test('a raw fragment containing a $ token is not renumbered', () => {
    const body = raw('$$ begin return $1; end $$');
    const fragment = sql`do ${body} with ${'arg'}`;
    expect(fragment.text).toBe('do $$ begin return $1; end $$ with $1');
    expect(fragment.values).toEqual(['arg']);
  });

  test('join composes fragments and keeps parameter order', () => {
    const parts = [sql`a = ${1}`, sql`b = ${2}`, sql`c = ${3}`];
    const fragment = sql`select where ${join(parts, ' and ')}`;
    expect(fragment.text).toBe('select where a = $1 and b = $2 and c = $3');
    expect(fragment.values).toEqual([1, 2, 3]);
  });

  test('literal escapes embedded quotes', () => {
    expect(literal("o'brien").text).toBe("'o''brien'");
  });
});

// Doubling the quote is not the whole rule, and `standard_conforming_strings` is why. It is
// settable per session, per database and per role and `SET` needs no privilege, so with it OFF a
// backslash escapes the character after it inside an ordinary `'…'` — a value is silently read as
// a different value, and one ending in a backslash escapes the closing quote and leaves the literal
// unterminated. `packages/db/src/column-default.ts:43` reaches here with an app's own
// `.default('C:\\logs')`, so this is caller input whatever the old comment claimed. Same rule and
// same measurement as `packages/entity/src/sql-literal.ts`.
describe('literal', () => {
  test('a value carrying no backslash is byte-identical to what it always was', () => {
    // Load-bearing: both tracked apps have applied migrations on disk with hashes over this text.
    expect(literal('draft').text).toBe("'draft'");
    expect(literal('').text).toBe("''");
    expect(literal("x'; drop table posts; --").text).toBe("'x''; drop table posts; --'");
    expect(literal('draft').text.startsWith('E')).toBe(false);
  });

  test('a value carrying a backslash is an E-string with the backslash doubled', () => {
    expect(literal('C:\\logs').text).toBe("E'C:\\\\logs'");
  });

  test('a value that is ONLY a backslash still closes its own literal', () => {
    expect(literal('\\').text).toBe("E'\\\\'");
  });

  test('a value ENDING in a backslash does not escape the closing quote', () => {
    expect(literal('a\\').text).toBe("E'a\\\\'");
  });

  test('both escapes apply together, and the quote is still doubled', () => {
    expect(literal("o'brien\\").text).toBe("E'o''brien\\\\'");
  });

  // The other half of the change: this package's own lexer has to read back what its escape
  // writes, or `statementsOf` starts miscounting and `multipleStatements` refuses a migration
  // holding one statement. `sql-scan.ts` already knows the `E''` prefix (`escapesAt`), and inside
  // one a backslash escapes — which is exactly why the doubling is not optional. A value carrying
  // a backslash NEXT TO a quote is the shape that tells the two apart: emit `E'…'` without
  // doubling and `\'` reads as an escaped quote, the literal ends early, and the `;` after it is
  // a statement separator instead of data.
  test('statementsOf reads an E-string whole, semicolons inside it included', () => {
    const script = `select ${literal("a\\'b; drop table posts; --").text};`;
    expect(statementsOf(script)).toHaveLength(1);
    expect(statementsOf(script)[0]).toContain('drop table posts');
  });
});
