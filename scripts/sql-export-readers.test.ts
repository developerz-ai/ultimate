// The enforcement half of `scripts/sql-export-readers.ts`: this file IS the build error. The real
// tree is asserted NON-VACUOUSLY — a scan that read no entry file would report "every export has a
// reader", which is the answer a clean tree gives too.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { CorpusFile } from './lib/corpus';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import {
  checkSqlExportReaders,
  type EntryFile,
  entryPathsOf,
  scanSqlExportReaders,
  sqlExportsOf,
  unreadSqlExports,
} from './sql-export-readers';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

/** A fixture file whose masks are its text: none of these fixtures carries a comment. */
const file = (path: string, source: string): CorpusFile => ({
  path,
  source,
  masked: source,
  stripped: source,
});

const entry = (pkg: string, source: string): EntryFile => ({
  pkg,
  file: file(`${pkg}/src/index.ts`, source),
});

describe('what an entry exports', () => {
  test('a re-export list, its `as` renames and an inline `export const`', () => {
    const names = sqlExportsOf(
      entry(
        'packages/a',
        [
          "export { store, SQL_A_TABLE, SQL_A_GET } from './store';",
          "export { SQL_INNER as SQL_A_PUBLIC } from './inner';",
          'export const SQL_A_INLINE = `select 1`;',
          "export type { SQL_NOT_A_STATEMENT_TYPE } from './types';",
          "export { sqlLowercase } from './x';",
        ].join('\n'),
      ),
    ).map((one) => one.name);
    expect(names).toEqual([
      'SQL_A_TABLE',
      'SQL_A_GET',
      'SQL_A_PUBLIC',
      'SQL_NOT_A_STATEMENT_TYPE',
      'SQL_A_INLINE',
    ]);
  });

  test('the `exports` map names the entries, conditions and subpaths included', () => {
    expect(
      entryPathsOf({
        exports: {
          '.': './src/index.ts',
          './server': { bun: './src/server.ts' },
          './x': './x.css',
        },
      }),
    ).toEqual(['src/index.ts', 'src/server.ts']);
    expect(entryPathsOf({ exports: './src/index.ts' })).toEqual(['src/index.ts']);
    expect(entryPathsOf({})).toEqual([]);
  });
});

describe('what counts as a reader', () => {
  const entries = [entry('packages/a', "export { SQL_A_TABLE, SQL_A_GET } from './store';")];

  test('a file outside the package naming it is a reader; the package itself never is', () => {
    const unread = unreadSqlExports(entries, [
      file('packages/a/src/store.ts', 'export const SQL_A_GET = `select`; run(SQL_A_GET);'),
      file('packages/b/src/boot.ts', "import { SQL_A_TABLE } from '@x/a';"),
    ]);
    expect(unread.map((one) => one.name)).toEqual(['SQL_A_GET']);
  });

  test('a longer name sharing the prefix is not a read of the shorter one', () => {
    const unread = unreadSqlExports(entries, [
      file('packages/b/src/boot.ts', 'use(SQL_A_TABLE_V2); use(SQL_A_GETTER);'),
    ]);
    expect(unread.map((one) => one.name)).toEqual(['SQL_A_TABLE', 'SQL_A_GET']);
  });

  test('a script or a tracked app is a reader as much as a package is', () => {
    const unread = unreadSqlExports(entries, [
      file('scripts/apply.ts', 'apply(SQL_A_TABLE);'),
      file('examples/dummy/apps/web/api/x.ts', 'apply(SQL_A_GET);'),
    ]);
    expect(unread).toEqual([]);
  });

  // `SQL_CLAIM`, `SQL_OUTBOX_RELEASE` and `SQL_NOTIFY_INBOX_MARK_READ` stayed public for one live
  // test in `@ultimat3/cli`: a test that runs a statement can live in the statement's own package.
  // A TABLE is different — a suite elsewhere has to apply it before it can test anything.
  test('a test is a reader of a *_TABLE only; any other statement needs a non-test reader', () => {
    const unread = unreadSqlExports(entries, [
      file('packages/b/src/array.live.test.ts', 'apply(SQL_A_TABLE); run(SQL_A_GET);'),
    ]);
    expect(unread.map((one) => one.name)).toEqual(['SQL_A_GET']);
  });

  test('every test suffix counts as a test, and a fixture module beside one does not', () => {
    for (const path of [
      'packages/b/src/x.test.ts',
      'packages/b/src/x.live.test.ts',
      'packages/b/src/x.contract.test.tsx',
      'examples/dummy/apps/web/app/x.job.test.ts',
    ]) {
      expect(unreadSqlExports(entries, [file(path, 'run(SQL_A_GET);')]).map((u) => u.name)).toEqual(
        ['SQL_A_TABLE', 'SQL_A_GET'],
      );
    }
    expect(
      unreadSqlExports(entries, [file('packages/b/src/x-fixture.ts', 'run(SQL_A_GET);')]).map(
        (u) => u.name,
      ),
    ).toEqual(['SQL_A_TABLE']);
  });

  test('a finding names the export, the package, and the edit that closes it', () => {
    const [finding] = checkSqlExportReaders({
      entries,
      unread: [{ pkg: 'packages/a', name: 'SQL_A_GET', at: 'packages/a/src/index.ts:1' }],
    });
    expect(finding?.code).toBe('X_SQL_EXPORT_UNREAD');
    expect(finding?.fix?.startsWith('bun run sql-export-readers --json')).toBe(true);
    expect(finding?.fix).toContain(
      'deleting SQL_A_GET from the export list at packages/a/src/index.ts:1',
    );
  });

  test('no entry read is a refusal, never a clean answer', () => {
    expect(checkSqlExportReaders({ entries: [], unread: [] }).map((one) => one.code)).toEqual([
      'X_SQL_EXPORT_UNSCANNED',
    ]);
  });
});

describe('the real tree', () => {
  test('every SQL_* a package entry exports has a reader outside that package', async () => {
    const { entries, findings } = await scanSqlExportReaders(repoRoot());
    // Non-vacuous: thirty-odd packages declare entries, and the DDL that boots read is among them.
    expect(entries.length).toBeGreaterThan(30);
    expect(entries.some((one) => one.file.path === 'packages/action/src/index.ts')).toBe(true);
    expect(findings).toEqual([]);
  });
});
