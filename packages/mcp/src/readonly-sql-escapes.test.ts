// What the scan cannot read is refused, never decoded: a Unicode-escaped quoted identifier
// (`U&"…"`), and the functions that run a query handed to them as TEXT — whose body every literal-
// blanking pass in this file is built not to see. Plus the word scan's unit: an identifier is
// what Postgres lexes as one, so `set2` is a column and never the keyword `set`.

import { describe, expect, test } from 'bun:test';
import { isUltimateError, type UltimateError } from '@ultimat3/core';
import { assertReadOnlyQuery } from './readonly-sql';

const refusal = { code: 'X_MCP_QUERY_REJECTED' };

/** The thrown value as what it is. Declared here: a test file importing another one runs it. */
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

describe('a Unicode-escaped quoted identifier is refused, never decoded', () => {
  test('a banned call spelled with escapes', () => {
    // `U&"pg\0073leep"` is `pg_sleep` to Postgres — the scan read the escape verbatim.
    for (const sql of [
      String.raw`select U&"pg\005fsleep"(10)`,
      String.raw`select u&"pg\005fsleep"(10)`,
      `select U&"!0070g_sleep" UESCAPE '!' (10)`,
      'select 1 from posts where id = 1 and U&"x" = 1',
      String.raw`select'a'U&"pg\005fsleep"(10)`,
    ]) {
      const error = caught(() => assertReadOnlyQuery(sql));
      expect(error).toMatchObject(refusal);
      expect(error.cause).toContain('U&');
    }
  });

  test('its neighbours still read: a column ending in u, a U& string literal, & as an operator', () => {
    for (const sql of [
      'select flags & "mask" from settings',
      'select menu&"mask" from settings',
      'select u & "mask" from settings',
      String.raw`select U&'d\0061t\+000061' as word`,
      `select 'U&"x"' as text`,
      '-- U&"x"\nselect 1',
    ]) {
      expect(assertReadOnlyQuery(sql)).toBe(sql);
    }
  });
});

describe('a function that runs SQL handed to it as text is refused', () => {
  test('the XML query-execution family, every member', () => {
    for (const sql of [
      "select query_to_xml('select 1', true, false, '')",
      "select query_to_xml_and_xmlschema('select 1', true, false, '')",
      "select query_to_xmlschema('select 1', true, false, '')",
      "select cursor_to_xml('c', 1, true, false, '')",
      "select table_to_xml('posts', true, false, '')",
      "select schema_to_xml('public', true, false, '')",
      "select database_to_xml(true, false, '')",
      "select pg_catalog.QUERY_TO_XML('select 1', true, false, '')",
      "select \"query_to_xml\"('select 1', true, false, '')",
      "select query_to_xml /* c */ ('select 1', true, false, '')",
    ]) {
      expect(caught(() => assertReadOnlyQuery(sql))).toMatchObject(refusal);
    }
  });

  test('the text-search pair that runs a query string', () => {
    for (const sql of [
      "select * from ts_stat('select body_tsv from posts')",
      "select ts_rewrite('a & b'::tsquery, 'select t, s from aliases')",
    ]) {
      expect(caught(() => assertReadOnlyQuery(sql))).toMatchObject(refusal);
    }
  });

  test('the name inside a string literal, or as a column, is not a call', () => {
    for (const sql of [
      "select 'query_to_xml(1)' as note",
      'select query_to_xml_count from stats',
      'select xmlelement(name p, title) from posts',
    ]) {
      expect(assertReadOnlyQuery(sql)).toBe(sql);
    }
  });
});

describe('the word scan reads an identifier as Postgres lexes one', () => {
  test('a column with digits or $ is not the keyword its letters start with', () => {
    for (const sql of [
      'select set2 from posts',
      'select into_count, update2, delete$ from stats',
      'select 1 as start_9',
      'select café_set from menu',
    ]) {
      expect(assertReadOnlyQuery(sql)).toBe(sql);
    }
  });

  test('the keyword itself, in any case or behind a digit or a comment, is still refused', () => {
    for (const sql of [
      'select 1; SET role admin',
      'select 1 INTO t2',
      'select 1 Into t2',
      'select 1/**/into t2',
      'select 1into t2',
      'select $1into t2',
      'select 2 from x where 1=1 for update',
    ]) {
      expect(caught(() => assertReadOnlyQuery(sql))).toMatchObject(refusal);
    }
  });

  test('a leader glued to digits is not a read leader', () => {
    expect(caught(() => assertReadOnlyQuery('select2 1'))).toMatchObject(refusal);
  });
});

describe('a call that writes the catalog is refused', () => {
  test('pg_import_system_collations, which inserts rows into pg_collation', () => {
    for (const sql of [
      "select pg_import_system_collations('pg_catalog')",
      "select pg_catalog.PG_IMPORT_SYSTEM_COLLATIONS('pg_catalog')",
      'select "pg_import_system_collations"(\'pg_catalog\')',
    ]) {
      expect(caught(() => assertReadOnlyQuery(sql))).toMatchObject(refusal);
    }
    // The catalog it writes is still readable.
    expect(assertReadOnlyQuery('select collname from pg_collation')).toBe(
      'select collname from pg_collation',
    );
  });
});
