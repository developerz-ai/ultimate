// Single responsibility: `X_SCHEMA_DUMP_DRIFT`'s comparisons — a committed dump against a rendered
// one in both directions, and the load-equals-replay verdict with the fix that differs from it.

import { describe, expect, test } from 'bun:test';
import {
  compareSchemaDump,
  reloadDifferences,
  SCHEMA_DUMP_FIX,
  schemaDumpDifferenceOf,
  schemaDumpDrift,
  unloadableDump,
} from './dump-drift';
import { dbUnavailable } from './errors';
import type { SchemaDumpFile } from './schema-dump';

const file = (path: string, content = `-- ${path}\n`): SchemaDumpFile => ({ path, content });

describe('compareSchemaDump', () => {
  test('an identical dump has no difference', () => {
    const files = [file('04_tables/posts.sql'), file('05_indexes/posts.sql')];
    expect(compareSchemaDump(files, files)).toEqual([]);
  });

  test('a stale dump is X_SCHEMA_DUMP_DRIFT naming the file, fixed by x db gen', () => {
    const rendered = [file('04_tables/posts.sql', 'create table "posts" ("id" uuid);\n')];
    const committed = [file('04_tables/posts.sql', 'create table "posts" ("id" text);\n')];
    const [difference, ...rest] = compareSchemaDump(committed, rendered);
    expect(rest).toEqual([]);
    expect(difference?.kind).toBe('changed-file');
    const error = schemaDumpDrift(difference ?? expect.unreachable());
    expect(error.code).toBe('X_SCHEMA_DUMP_DRIFT');
    expect(error.cause).toBe(
      'schema dump file 04_tables/posts.sql differs from what the migrations produce',
    );
    expect(error.fix).toBe('x db gen');
    expect(error.meta).toEqual({ kind: 'changed-file', path: '04_tables/posts.sql' });
  });

  test('both directions: a file nobody committed, and a file nothing renders', () => {
    const differences = compareSchemaDump([file('04_tables/old.sql')], [file('04_tables/new.sql')]);
    expect(differences.map((difference) => [difference.kind, difference.path])).toEqual([
      ['missing-file', '04_tables/new.sql'],
      ['unexpected-file', '04_tables/old.sql'],
    ]);
    expect(differences.every((difference) => difference.fix === SCHEMA_DUMP_FIX)).toBe(true);
  });

  test('a single trailing byte is a difference', () => {
    const rendered = [file('04_tables/posts.sql', 'x\n')];
    expect(compareSchemaDump([file('04_tables/posts.sql', 'x\n\n')], rendered)).toHaveLength(1);
  });
});

describe('reloadDifferences', () => {
  const replayed = [file('04_tables/posts.sql'), file('07_views/report.sql', 'a\n')];

  test('load equals replay is silence', () => {
    expect(reloadDifferences(replayed, replayed)).toEqual([]);
  });

  test('one finding, naming the first file that came back different', () => {
    const differences = reloadDifferences(replayed, [
      file('04_tables/posts.sql'),
      file('07_views/report.sql', 'b\n'),
    ]);
    expect(differences).toHaveLength(1);
    expect(differences[0]?.kind).toBe('reload-differs');
    expect(differences[0]?.path).toBe('07_views/report.sql');
    expect(differences[0]?.cause).toContain('07_views/report.sql comes back different');
  });

  test('its fix starts with the command and says what a second refusal means', () => {
    const [difference] = reloadDifferences(replayed, [file('04_tables/posts.sql')]);
    expect(difference?.fix).toStartWith('x db gen   # ');
    expect(difference?.fix).toContain('07_views/report.sql');
    // Not the bare command: regenerating alone cannot repair a dump that renders an object wrong.
    expect(difference?.fix).not.toBe(SCHEMA_DUMP_FIX);
  });
});

describe('schemaDumpDifferenceOf', () => {
  test('reads a thrown refusal back into the difference it was built from', () => {
    const difference = unloadableDump('07_views/report.sql', 'relation "posts" does not exist');
    expect(schemaDumpDifferenceOf(schemaDumpDrift(difference))).toEqual(difference);
  });

  test('a file that will not load is the round-trip fix too: regenerating rewrites it the same', () => {
    const difference = unloadableDump('07_views/report.sql', 'no');
    expect(difference.fix).toStartWith('x db gen   # ');
    expect(difference.fix).toContain('07_views/report.sql');
  });

  test('anything else is not a dump difference', () => {
    expect(schemaDumpDifferenceOf(dbUnavailable('down'))).toBeUndefined();
    expect(schemaDumpDifferenceOf(new Error('boom'))).toBeUndefined();
    expect(schemaDumpDifferenceOf(undefined)).toBeUndefined();
  });
});
