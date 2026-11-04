// Single responsibility: pin that a statement text leaving `x db diagnostics` carries its shape and
// none of its values — the rule that lets a session's SQL be printed at all.

import { describe, expect, test } from 'bun:test';
import { QUERY_TEXT_MAX, redactQueryText } from './db-diagnostics-redact';

describe('redactQueryText', () => {
  test('string, dollar-quoted and numeric literals become ?, identifiers and $n stay', () => {
    expect(
      redactQueryText(
        `update "users" set email = 'ada@example.com', note = $$secret$$, n = 42 where id = $1 and t1.x = 3.5e2`,
      ),
    ).toBe('update "users" set email = ?, note = ?, n = ? where id = $1 and t1.x = ?');
  });

  // Postgres 16 integer spellings: a prefix base and `_` between digits are one literal each.
  test.each([
    ['0xDEADBEEF'],
    ['0XdeadBEEF'],
    ['0b1011'],
    ['0o777'],
    ['0x_FF_FF'],
    ['1_234_567'],
    ['1_000.000_5'],
    ['.5_0'],
    ['1e1_0'],
    ['2.5E-1_2'],
  ])('%s is one literal, redacted whole', (literal) => {
    expect(redactQueryText(`select ${literal} from t where n = -${literal}`)).toBe(
      'select ? from t where n = -?',
    );
  });

  test('an escape string and a doubled quote are one literal, never a leak', () => {
    expect(redactQueryText(`select E'it\\'s' , 'o''brien' from posts`)).toBe(
      'select ? , ? from posts',
    );
  });

  test('comments go, whitespace collapses, a cast keeps its type name', () => {
    expect(redactQueryText('select /* pid 7 */ 1::int4 -- trailing 99\n  from   t')).toBe(
      'select ?::int4 from t',
    );
  });

  // `track_activity_query_size` cuts the server's copy mid-literal: an open quote runs to the end.
  test('a literal the server truncated is redacted to the end of the text', () => {
    expect(redactQueryText("insert into t values ('half a sec")).toBe('insert into t values (?');
  });

  test('a text past the ceiling is cut after redaction and marked', () => {
    const long = `select ${'a, '.repeat(QUERY_TEXT_MAX)}'tail-secret'`;
    const out = redactQueryText(long);
    expect(out.length).toBe(QUERY_TEXT_MAX + 1);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toContain('tail-secret');
  });
});
