import { describe, expect, test } from 'bun:test';
import { isSqlFragment, join, literal, raw, sql } from './sql';

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
