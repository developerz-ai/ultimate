// Where Postgres ends a `--` comment, and what the scanner sees after it. Split from
// `readonly-sql.test.ts` at the 500-line ceiling: this is one subject — the lexer's own
// `non_newline` rule — and every case here is a payload hidden from FIVE checks by one byte.

import { describe, expect, test } from 'bun:test';
import { isUltimateError, type UltimateError } from '@ultimat3/core';
import { assertReadOnlyQuery } from './readonly-sql';

const refusal = { code: 'X_MCP_QUERY_REJECTED' };

/**
 * The thrown value as what it is, so a test can read `cause`/`fix` rather than a message. The
 * miss is an assertion and never a `throw new Error`: `expect.unreachable` is this repo's idiom,
 * and it returns `never`, which is what narrows `thrown` below. Declared here rather than imported
 * from a sibling suite — a test file that imports another test file runs it.
 */
const caught = (fn: () => unknown): UltimateError => {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  if (!isUltimateError(thrown)) expect.unreachable('expected the call to throw an UltimateError');
  return thrown;
};

/**
 * Postgres' lexer ends a `--` comment at `non_newline`, which it defines as `[^\n\r]` — so a bare
 * CARRIAGE RETURN ends the comment for the server. A scanner looking only for `\n` keeps blanking
 * past it, and everything after the CR is real SQL the server runs and this file never sees: the
 * statement split, the read-leader check, the write-keyword scan, the forbidden-call scan and the
 * `FOR UPDATE` regex all read the stripped form, so one CR hides a payload from all five at once.
 * `verbatim()` then hands the caller's bytes back to be executed.
 */
describe('a -- comment ends at a CR, because that is where Postgres ends it', () => {
  test('a second statement behind a CR is a batch, not a comment', () => {
    // Reproduced against a real server: this exact string was returned verbatim, and the row's
    // role read `admin` afterwards.
    expect(
      caught(() => assertReadOnlyQuery("select 1;--\rupdate members set role='admin'")),
    ).toMatchObject(refusal);
    expect(
      caught(() => assertReadOnlyQuery('select 1;--\rselect pg_advisory_lock(42)')),
    ).toMatchObject(refusal);
  });

  test('a write on the far side of a CR is seen by the keyword scan', () => {
    expect(
      caught(() => assertReadOnlyQuery("select 1 --\rupdate members set role='admin'")),
    ).toMatchObject(refusal);
  });

  test('a forbidden call on the far side of a CR is seen by the family scan', () => {
    // The advisory lock is the case layer 2 cannot repair: a SESSION lock survives the ROLLBACK,
    // so it outlives the read on a pooled connection the app's own writers use.
    expect(
      caught(() => assertReadOnlyQuery('select 1 --\rselect pg_advisory_lock(42)')),
    ).toMatchObject(refusal);
  });

  test('CRLF is one terminator, so a CRLF file behaves exactly as an LF one does', () => {
    expect(
      caught(() => assertReadOnlyQuery("select 1 --\r\nupdate members set role='admin'")),
    ).toMatchObject(refusal);

    const wrapped = 'select id from posts -- the published ones\r\nwhere published_at is not null';
    expect(assertReadOnlyQuery(wrapped)).toBe(wrapped);
  });

  test('a CR inside a string literal is literal content, never a comment terminator', () => {
    // The comment branch never runs here — the quote opens first — so the `drop` after the CR is
    // inside the literal for Postgres too, and refusing it would cost an ordinary read.
    const sql = "select 'a\rdrop table posts' as note";
    expect(assertReadOnlyQuery(sql)).toBe(sql);
  });
});
