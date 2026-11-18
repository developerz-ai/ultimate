// Single responsibility: the pure half of the schema dump — which file each rendered statement
// lands in, how a file is headed and split, and what the dump names as unrendered. No database.

import { describe, expect, test } from 'bun:test';
import { type CatalogDescription, emptyCatalog } from './catalog';
import {
  dumpFileName,
  renderSchemaDump,
  SCHEMA_DUMP_HEADER,
  SCHEMA_DUMP_MAX_LINES,
  type SchemaDumpFile,
} from './schema-dump';
import { statementsOf } from './statement-split';

const paths = (files: readonly SchemaDumpFile[]): readonly string[] => files.map((f) => f.path);

describe('renderSchemaDump · which file a statement lands in', () => {
  const view = (name: string, materialized = false) => ({
    name,
    materialized,
    options: null,
    definition: ' SELECT 1 AS one;',
  });

  test('nothing in, nothing out', () => {
    expect(renderSchemaDump(emptyCatalog())).toEqual([]);
  });

  test('an x_ object goes to the framework twin; its indexes and keys follow their table', () => {
    const catalog: CatalogDescription = {
      ...emptyCatalog(),
      indexes: [
        {
          table: 'x_jobs',
          name: 'x_jobs_idx',
          definition: 'CREATE INDEX x_jobs_idx ON x_jobs (id)',
        },
        { table: 'posts', name: 'posts_idx', definition: 'CREATE INDEX posts_idx ON posts (id)' },
      ],
      foreignKeys: [
        {
          table: 'x_sessions',
          name: 'x_sessions_user_fkey',
          definition: 'FOREIGN KEY (u) REFERENCES x_users(id)',
        },
      ],
    };
    expect(paths(renderSchemaDump(catalog))).toEqual([
      '05_indexes/posts.sql',
      'framework/05_indexes/x_jobs.sql',
      'framework/06_foreign_keys/x_sessions.sql',
    ]);
  });

  test('every file opens with the header and ends in exactly one newline', () => {
    const [file] = renderSchemaDump({ ...emptyCatalog(), views: [view('report')] });
    expect(file?.content).toBe(
      `${SCHEMA_DUMP_HEADER}\n\ncreate view "report" as\nSELECT 1 AS one;\n`,
    );
  });

  test('a materialized view’s index rides in the view’s file, after the view', () => {
    const files = renderSchemaDump({
      ...emptyCatalog(),
      views: [view('totals', true)],
      indexes: [
        {
          table: 'totals',
          name: 'totals_idx',
          definition: 'CREATE INDEX totals_idx ON totals (one)',
        },
      ],
    });
    expect(paths(files)).toEqual(['07_views/totals.sql']);
    // The exact tail, not two `indexOf`s compared: a missing statement answers -1, and -1 is
    // less than anything.
    expect(files[0]?.content).toEndWith(
      'create materialized view "totals" as\nSELECT 1 AS one;\n\n' +
        'CREATE INDEX totals_idx ON totals (one);\n',
    );
  });

  test('two overloads share one file; a disabled trigger says so', () => {
    const files = renderSchemaDump({
      ...emptyCatalog(),
      functions: [
        { name: 'add', arguments: 'a integer', definition: 'CREATE FUNCTION add(a integer)' },
        { name: 'add', arguments: 'a text', definition: 'CREATE FUNCTION add(a text)' },
      ],
      triggers: [
        {
          table: 'posts',
          name: 'posts_touch',
          definition: 'CREATE TRIGGER posts_touch',
          enabled: 'D',
        },
      ],
    });
    expect(paths(files)).toEqual(['08_functions/add.sql', '09_triggers/posts.sql']);
    expect(files[0]?.content).toContain('add(a integer);\n\nCREATE FUNCTION add(a text);');
    expect(files[1]?.content).toContain('alter table "posts" disable trigger "posts_touch";');
  });

  test('a name is encoded, so no object can write outside its directory', () => {
    expect(dumpFileName('posts')).toBe('posts');
    expect(dumpFileName('../../etc/passwd')).toBe('%2E%2E%2F%2E%2E%2Fetc%2Fpasswd');
    expect(dumpFileName('weird name.1')).toBe('weird%20name%2E1');
  });

  test('a file over the ceiling is split into numbered parts, never exempted', () => {
    const many = Array.from({ length: SCHEMA_DUMP_MAX_LINES }, (_, at) => ({
      table: 'wide',
      name: `wide_${String(at).padStart(4, '0')}_idx`,
      definition: `CREATE INDEX wide_${at}_idx ON wide (c${at})`,
    }));
    const files = renderSchemaDump({ ...emptyCatalog(), indexes: many });
    expect(paths(files)).toEqual([
      '05_indexes/wide.1.sql',
      '05_indexes/wide.2.sql',
      '05_indexes/wide.3.sql',
    ]);
    for (const file of files) {
      expect(file.content.split('\n').length - 1).toBeLessThanOrEqual(SCHEMA_DUMP_MAX_LINES);
    }
    // Nothing lost at a cut: the parts joined are the unsplit file, last statement included.
    expect(files.map((file) => file.content).join('')).toEndWith(
      'CREATE INDEX wide_499_idx ON wide (c499);\n',
    );
  });

  test('an object the dump cannot spell is named in unrendered.sql, per twin', () => {
    const files = renderSchemaDump({
      ...emptyCatalog(),
      unrendered: [
        { kind: 'row security policy', name: 'tenant_only', table: 'posts' },
        { kind: 'partitioned table', name: 'x_events', table: null },
      ],
    });
    expect(paths(files)).toEqual(['framework/unrendered.sql', 'unrendered.sql']);
    expect(files[1]?.content).toContain(
      '-- not rendered: row security policy "tenant_only" on "posts"',
    );
    expect(statementsOf(files[1]?.content ?? '')).toEqual([]);
  });
});
