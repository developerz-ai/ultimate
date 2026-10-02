// Single responsibility: the ORDER the loader runs files in. What it does against a database —
// the retried dependencies, the refusal — is in `schema-dump.test.ts`, which already pays for the
// one embedded boot this package's dump tests share.

import { describe, expect, test } from 'bun:test';
import type { SchemaDumpFile } from './schema-dump';
import { loadOrder } from './schema-load';

const file = (path: string, content = ''): SchemaDumpFile => ({ path, content });

describe('loadOrder', () => {
  test('by kind, the framework twin first within a kind, then by name', () => {
    const order = loadOrder([
      file('06_foreign_keys/posts.sql'),
      file('04_tables/posts.sql'),
      file('framework/05_indexes/x_jobs.sql'),
      file('framework/04_tables/x_users.sql'),
      file('04_tables/orgs.sql'),
      file('unrendered.sql'),
    ]).map((unit) => unit.path);
    expect(order).toEqual([
      'unrendered.sql',
      'framework/04_tables/x_users.sql',
      '04_tables/orgs.sql',
      '04_tables/posts.sql',
      'framework/05_indexes/x_jobs.sql',
      '06_foreign_keys/posts.sql',
    ]);
  });

  test('a split file is one unit, its parts joined in numeric order', () => {
    const parts = Array.from({ length: 11 }, (_, at) =>
      file(`04_tables/wide.${at + 1}.sql`, `part ${at + 1}\n`),
    );
    const [unit, ...rest] = loadOrder([...parts].reverse());
    expect(rest).toEqual([]);
    expect(unit?.path).toBe('04_tables/wide.sql');
    // `.10.sql` after `.9.sql` — a string sort would put it second.
    expect(unit?.script.split('\n').slice(8, 11)).toEqual(['part 9', 'part 10', 'part 11']);
  });
});
