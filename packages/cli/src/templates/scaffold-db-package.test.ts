// What `x new` puts in `packages/db` about the schema dump: the attributes that keep a generated
// directory byte-stable across checkouts, and NOT the directory — `x db gen` is its one writer.

import { describe, expect, test } from 'bun:test';
import { SCHEMA_DUMP_DIR } from '../db-schema-dump';
import { MIGRATIONS_DIR } from '../migrations';
import { names } from './naming';
import { DB_GITATTRIBUTES, dbPackageFiles } from './scaffold-db-package';

describe('unit · the packages/db x new writes', () => {
  for (const example of [true, false]) {
    const files = dbPackageFiles(names('ledger-demo'), example);
    const mode = example ? 'with the example' : 'with --no-example';

    test(`${mode}: the dump's attributes ship beside the package`, () => {
      const attributes = files.find((file) => file.path === 'packages/db/.gitattributes');
      expect(attributes?.contents).toBe(DB_GITATTRIBUTES);
    });

    test(`${mode}: no migration and no dump — x db gen writes both`, () => {
      const generated = files.filter(
        (file) =>
          file.path.startsWith(`${MIGRATIONS_DIR}/`) || file.path.startsWith(`${SCHEMA_DUMP_DIR}/`),
      );
      expect(generated).toEqual([]);
    });
  }

  test('the pattern is relative to packages/db and covers the directory the gate reads', () => {
    // The `.gitattributes` sits in `packages/db`, so its pattern must be the dump directory's
    // name relative to it — derived here, so a moved `SCHEMA_DUMP_DIR` fails this line.
    const relative = SCHEMA_DUMP_DIR.replace(/^packages\/db\//, '');
    const rule = DB_GITATTRIBUTES.split('\n').find((line) => !line.startsWith('#') && line !== '');
    expect(rule).toBe(`${relative}/** linguist-generated=true text eol=lf`);
  });

  test('line endings are pinned: the gate compares bytes, and CRLF is a different dump', () => {
    expect(DB_GITATTRIBUTES).toContain('eol=lf');
  });
});
