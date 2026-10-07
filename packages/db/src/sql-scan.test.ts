// The block-comment rule `sql-scan.ts` exports for a second reader (`@ultimat3/mcp`'s read-only
// check): Postgres NESTS `/* */`, and a comment that never closes is reported, never guessed.
import { describe, expect, test } from 'bun:test';
import { dollarTagAt, endOfBlockComment, noiseAt } from './sql-scan';

describe('endOfBlockComment', () => {
  test('a nested comment closes at its OUTER terminator, not the first one', () => {
    const sql = "select /* /* */ ' */ pg_advisory_lock(42) --'";
    expect(sql.slice(endOfBlockComment(sql, 7) ?? -1)).toBe(" pg_advisory_lock(42) --'");
  });

  test('a flat comment closes at its terminator', () => {
    expect(endOfBlockComment('/* a */ b', 0)).toBe(7);
  });

  test('a comment that never closes its outer level is null, not the end of the text', () => {
    expect(endOfBlockComment('select 1 /* /* */ ; delete from members', 9)).toBeNull();
    expect(endOfBlockComment('/* a', 0)).toBeNull();
  });

  test('the lexer reads the same span: an unclosed comment runs to the end of the script', () => {
    expect(noiseAt('/* /* */ x */ y', 0)).toEqual({ kind: 'block-comment', end: 13 });
    expect(noiseAt('/* /* */ x', 0)).toEqual({ kind: 'block-comment', end: 10 });
  });
});

// Read against Postgres 17 (UTF8): a tag and the identifier a `$` may continue both take any
// non-ASCII character, as the lexer's `dolq_start`/`ident_start` do — and `$1` before a tag is a
// parameter, so the tag after it still opens a body.
describe('dollarTagAt — the tag grammar Postgres lexes', () => {
  test('a non-ASCII tag opens a body', () => {
    expect(dollarTagAt("select $é$ it's $é$", 7)).toBe('$é$');
    expect(dollarTagAt('$_é1$ q $_é1$', 0)).toBe('$_é1$');
  });

  test('a $ glued to a non-ASCII identifier continues it: `é$x$` is one name', () => {
    expect(dollarTagAt('select 1 as é$x$, 2', 13)).toBeNull();
  });

  test('a tag after a bound parameter still opens a body', () => {
    expect(dollarTagAt('select $1$tag$ x $tag$', 9)).toBe('$tag$');
  });

  test('a tag never starts with a digit', () => {
    expect(dollarTagAt('$1$', 0)).toBeNull();
  });
});
