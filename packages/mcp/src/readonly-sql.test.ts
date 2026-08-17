// The two halves of the gate, tested apart: what it refuses, and what it hands back to be run.
// The second half is the one that bites — the caller executes the return value, so a validator
// that "normalises" the statement silently changes the query the agent asked for.

import { describe, expect, test } from 'bun:test';
import { isUltimateError, type UltimateError } from '@ultimat3/core';
import { assertBranchDatabase, assertReadOnlyQuery } from './readonly-sql';

const refusal = { code: 'X_MCP_QUERY_REJECTED' };
const notBranch = { code: 'X_MCP_NOT_BRANCH_DB' };

describe('assertReadOnlyQuery returns what will actually run', () => {
  test('a read is returned byte-for-byte, minus surrounding whitespace and one trailing ;', () => {
    expect(assertReadOnlyQuery('  select id from posts  ')).toBe('select id from posts');
    expect(assertReadOnlyQuery('select id from posts;')).toBe('select id from posts');
    expect(assertReadOnlyQuery('select id from posts ;')).toBe('select id from posts');
  });

  test('a string literal holding a write keyword passes and survives verbatim', () => {
    const sql = "select 'delete from posts' as note";
    // Validation reads the stripped form; execution must read the author's form, or the row
    // comes back as `select   as note`.
    expect(assertReadOnlyQuery(sql)).toBe(sql);
  });

  test("SQL's doubled-quote escape does not leak the literal into the keyword scan", () => {
    const sql = "select 'it''s a drop table joke' as note";
    expect(assertReadOnlyQuery(sql)).toBe(sql);
  });

  test('a quoted identifier that looks like a write is a column name, not a statement', () => {
    const sql = 'select "update" from posts';
    expect(assertReadOnlyQuery(sql)).toBe(sql);
  });

  test('a comment holding a write keyword is ignored by validation and preserved', () => {
    const line = 'select id from posts -- drop table posts';
    expect(assertReadOnlyQuery(line)).toBe(line);

    const block = 'select /* drop table posts */ id from posts';
    expect(assertReadOnlyQuery(block)).toBe(block);
  });

  test('an escape string is scanned the way Postgres reads it, and still runs verbatim', () => {
    // A backslash that is not escaping a quote changes nothing about where the string ends, so
    // these stay readable: refusing every backslash would cost an agent ordinary reads.
    const escaped = String.raw`select E'a\nb' as note`;
    expect(assertReadOnlyQuery(escaped)).toBe(escaped);

    const pattern = String.raw`select id from posts where title ~ '\d+'`;
    expect(assertReadOnlyQuery(pattern)).toBe(pattern);

    const doubled = String.raw`select E'it''s fine \n' as note`;
    expect(assertReadOnlyQuery(doubled)).toBe(doubled);
  });

  test('a dollar-quoted body is opaque to the scan and untouched in the result', () => {
    const sql = 'select $tag$ truncate posts $tag$ as note';
    expect(assertReadOnlyQuery(sql)).toBe(sql);
  });

  test('every read leader is accepted', () => {
    for (const sql of [
      'select 1',
      'with t as (select 1) select * from t',
      'explain select 1',
      'show timezone',
      'table posts',
      'values (1)',
    ]) {
      expect(assertReadOnlyQuery(sql)).toBe(sql);
    }
  });
});

describe('assertReadOnlyQuery refuses', () => {
  test('an empty statement', () => {
    expect(() => assertReadOnlyQuery('   ')).toThrowError(expect.objectContaining(refusal));
    expect(() => assertReadOnlyQuery(';;')).toThrowError(expect.objectContaining(refusal));
  });

  test('a batch, because batching hides a write behind a read', () => {
    expect(() => assertReadOnlyQuery('select 1; drop table posts')).toThrowError(
      expect.objectContaining(refusal),
    );
  });

  test('a batch hidden behind an E-string backslash escape', () => {
    // `E'\''` is ONE quote in Postgres — the backslash escapes it and the third quote closes the
    // string — so the `;` that follows really does start a second statement. A scanner that knows
    // only the doubled-quote escape reads the string as still open, blanks the rest of the line
    // and counts one statement: this exact input was ACCEPTED and handed back verbatim to run.
    expect(() => assertReadOnlyQuery(String.raw`select E'\'' ; drop table posts --'`)).toThrowError(
      expect.objectContaining(refusal),
    );
    expect(() =>
      assertReadOnlyQuery(String.raw`select e'\'' ; update posts set title='x' --'`),
    ).toThrowError(expect.objectContaining(refusal));
  });

  test('an unterminated quoted run, which used to swallow the write that followed it', () => {
    // The scanner blanks what it believes is inside a literal, so an opening delimiter that never
    // closes hid the whole tail: `select '; delete from members` counted ONE statement with no
    // mutating keyword in it and was handed back to run. Not exploitable through Postgres — an
    // unterminated quote is a syntax error wherever it lands — but this layer's job is to refuse
    // what it cannot read, not to lean on the layer below. Over-refusing is fine; under-refusing
    // is the thing this whole file exists to prevent.
    for (const sql of [
      `select '; delete from members`,
      `select E'x ; delete from members`,
      `select "; delete from members`,
      `select $tag$ ; delete from members`,
      `select 1 /* ; delete from members`,
    ]) {
      expect(() => assertReadOnlyQuery(sql)).toThrowError(expect.objectContaining(refusal));
    }
  });

  test("a plain string's \\' — the same sequence, refused without the E", () => {
    // `standard_conforming_strings` (on by default, and a session setting no MCP caller can read
    // or change — `set` is a write keyword) decides whether this closes the string here. The
    // difference between the two readings is exactly where a `;` can hide, so it is refused
    // rather than parsed under one of them.
    expect(() => assertReadOnlyQuery(String.raw`select 'a\' ; drop table posts --'`)).toThrowError(
      expect.objectContaining(refusal),
    );
  });

  test('but a line comment still runs to the end of the line, apostrophe and all', () => {
    // `-- it's fine` is not an unterminated string: the comment branch consumes the rest of the
    // line before any quote is scanned. Refusing it would break an ordinary annotated read.
    for (const sql of [`select 1 -- it's fine`, `select /* it's fine */ 1 from posts`]) {
      expect(assertReadOnlyQuery(sql)).toBe(sql);
    }
  });

  test('but only inside a string: the same bytes in a comment or a dollar-quoted body read fine', () => {
    // Refusing the sequence wherever it appears would cost an agent ordinary reads. A comment and
    // a `$tag$` body are both unambiguous — nothing about a backslash changes where either ends.
    for (const sql of [
      String.raw`select 1 -- it\'s fine`,
      String.raw`select $tag$ it\'s fine $tag$ as note`,
      String.raw`select "a\'b" from posts`,
    ]) {
      expect(assertReadOnlyQuery(sql)).toBe(sql);
    }
  });

  test('a non-read leader', () => {
    expect(() => assertReadOnlyQuery("update posts set title = 'x'")).toThrowError(
      expect.objectContaining(refusal),
    );
  });

  test('a data-modifying CTE, which reads like a SELECT and is not one', () => {
    expect(() =>
      assertReadOnlyQuery('with d as (delete from posts returning id) select * from d'),
    ).toThrowError(expect.objectContaining(refusal));
  });

  test('a locking read', () => {
    expect(() => assertReadOnlyQuery('select id from posts for update')).toThrowError(
      expect.objectContaining(refusal),
    );
    expect(() => assertReadOnlyQuery('select id from posts FOR NO KEY UPDATE')).toThrowError(
      expect.objectContaining(refusal),
    );
  });

  test('a function that reaches outside the database', () => {
    expect(() => assertReadOnlyQuery("select pg_read_file('/etc/passwd')")).toThrowError(
      expect.objectContaining(refusal),
    );
    expect(() => assertReadOnlyQuery('select pg_sleep(10)')).toThrowError(
      expect.objectContaining(refusal),
    );
  });

  test('a lock taken as a call, which outlives the transaction the clause form dies with', () => {
    // `FOR UPDATE` is refused above because db.query may not hold locks. A SESSION advisory lock
    // is the same ban and the worse breach: layer 2's ROLLBACK does not release it, so it
    // outlives the read on a pooled connection. `db-integration.test.ts` proves that on a real
    // server — layers 1, 2 and 4 all let it through, so this is the only layer that can refuse.
    for (const sql of [
      'select pg_advisory_lock(42)',
      'select pg_try_advisory_lock(42)',
      'select pg_advisory_xact_lock(42)',
      'select pg_advisory_unlock_all()',
    ]) {
      expect(() => assertReadOnlyQuery(sql)).toThrowError(expect.objectContaining(refusal));
    }
  });

  test('SET spelled as a call, which the keyword scan tokenises as one word', () => {
    // `set` is a write keyword, but `set_config` is a single token and never matched it.
    expect(() =>
      assertReadOnlyQuery("select set_config('statement_timeout', '0', false)"),
    ).toThrowError(expect.objectContaining(refusal));
    expect(() =>
      assertReadOnlyQuery("select pg_catalog.set_config('search_path', 'evil', false)"),
    ).toThrowError(expect.objectContaining(refusal));
  });

  test('every member of a banned family, not only the spelling that was listed first', () => {
    for (const sql of [
      "select pg_sleep_for('1 hour')",
      'select pg_sleep_until(now())',
      "select pg_stat_file('/etc/passwd')",
      'select pg_ls_logdir()',
      "select pg_read_binary_file('/etc/passwd')",
      'select lo_get(1)',
      'select pg_stat_reset()',
    ]) {
      expect(() => assertReadOnlyQuery(sql)).toThrowError(expect.objectContaining(refusal));
    }
  });

  test('a quoted function name is the same call, not a way past the family', () => {
    // `SELECT "pg_advisory_lock"(1)` is valid Postgres and calls the function. Blanking quoted
    // identifiers before the scan — which the keyword pass still does, so `select "update"` stays
    // a column — hid exactly the call whose lock outlives layer 2's ROLLBACK.
    for (const sql of [
      'select "pg_advisory_lock"(918273)',
      'select pg_catalog."pg_sleep"(10)',
      'select"pg_read_file"(\'/etc/passwd\')',
      'select "pg_advisory_lock" (918273)',
    ]) {
      expect(() => assertReadOnlyQuery(sql)).toThrowError(expect.objectContaining(refusal));
    }
  });

  test('a column sharing a family prefix is a column, because only a call is checked', () => {
    // The family is a prefix of the CALLED function. Scanning every word refused this row —
    // fail-closed must not mean refusing a table an agent has every right to read.
    for (const sql of [
      'select pg_sleep_for_seconds from readings',
      'select lo_rate from billing',
      'select pg_read_ahead, pg_advisory_notes from metrics',
    ]) {
      expect(assertReadOnlyQuery(sql)).toBe(sql);
    }
  });

  test('the cause names the call the author wrote and the family that refused it', () => {
    expect(() => assertReadOnlyQuery("select pg_sleep_for('1 hour')")).toThrowError(
      expect.objectContaining({ cause: expect.stringContaining('pg_sleep_for()') }),
    );
    expect(() => assertReadOnlyQuery("select pg_sleep_for('1 hour')")).toThrowError(
      expect.objectContaining({ cause: expect.stringContaining('pg_sleep*') }),
    );
  });

  test('a prefix family does not swallow the catalog an agent legitimately reads', () => {
    // Fail-closed must not mean fail-useless: these share a prefix with nothing banned, and
    // `pg_stat_activity` sits right beside `pg_stat_file` and `pg_stat_reset`.
    for (const sql of [
      'select * from pg_stat_activity',
      'select * from pg_locks',
      'select * from pg_settings',
      'select "lo_rate" from billing',
      "select 'pg_sleep_for' as note",
    ]) {
      expect(assertReadOnlyQuery(sql)).toBe(sql);
    }
  });

  test('EXPLAIN ANALYZE, which executes the plan it claims to describe', () => {
    expect(() => assertReadOnlyQuery('explain analyze select 1')).toThrowError(
      expect.objectContaining(refusal),
    );
  });
});

describe('a refusal names the problem, and never the surface the reader is not on', () => {
  // This guard has two callers on two surfaces: the `db.query` MCP tool, and `@ultimat3/admin`'s
  // `/_x` DB panel, whose reader is a developer in a browser who never called an MCP tool and
  // cannot see one. The constructor used to prepend `db.query refused: ` to every cause, so the
  // panel rendered `refused: db.query refused: …` — a stutter naming a tool that is not there.
  // The tool identity was never missing: it is in the TITLE, which `format()` renders above the
  // cause and which every code carries independently of who threw it.
  const caught = (fn: () => unknown): UltimateError => {
    try {
      fn();
    } catch (error) {
      if (isUltimateError(error)) return error;
    }
    throw new Error('expected an UltimateError');
  };

  test('the cause is the problem alone', () => {
    const error = caught(() => assertReadOnlyQuery('select 1 /* ; delete from members'));

    expect(error.cause).toBe(
      'the statement ends inside a /* block comment, so the rest of it cannot be read',
    );
    expect(error.cause).not.toContain('db.query');
  });

  test('the surface is still named for an MCP reader, by the title format() renders', () => {
    const error = caught(() => assertReadOnlyQuery('select 1; drop table posts'));

    expect(error.format().split('\n')[0]).toBe(
      'X_MCP_QUERY_REJECTED: db.query was not given one read-only statement',
    );
    // One naming, in one place: the line below must not repeat what the line above already said.
    expect(error.format()).not.toContain('refused: db.query');
  });

  test('the branch refusal reads the same way', () => {
    const error = caught(() =>
      assertBranchDatabase({ label: 'prod', branch: 'main', production: true }),
    );

    expect(error.cause).toBe('"prod" is a production database');
    expect(error.format().split('\n')[0]).toBe(
      'X_MCP_NOT_BRANCH_DB: db.migrate was aimed at a database that is not a branch',
    );
  });
});

describe('assertBranchDatabase', () => {
  test('a branch database is allowed and names itself', () => {
    expect(assertBranchDatabase({ label: 'dev', branch: 'feat-x', production: false })).toBe(
      'feat-x',
    );
  });

  test('production and shared non-branch targets are refused separately', () => {
    expect(() =>
      assertBranchDatabase({ label: 'prod', branch: 'main', production: true }),
    ).toThrowError(expect.objectContaining(notBranch));
    expect(() =>
      assertBranchDatabase({ label: 'staging', branch: null, production: false }),
    ).toThrowError(expect.objectContaining(notBranch));
  });
});
