// The enforcement half of `scripts/framework-tables.ts`: this file IS the build error. The real
// tree is asserted NON-VACUOUSLY — a scan that read nothing would report "every table applied",
// which is the answer a correct tree gives, and is exactly how five auth tables went unnoticed
// under a green gate from the initial commit through all 21 released versions.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { FRAMEWORK_SCHEMA } from '@ultimat3/cli';
import { collectSourceFiles, type SourceFile } from './boundaries';
import type { DeclaredTable } from './framework-tables';
import { checkFrameworkTables, declaredTables } from './framework-tables';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

const UNAPPLIED = 'X_FRAMEWORK_TABLE_UNAPPLIED';
const UNSCANNED = 'X_FRAMEWORK_TABLE_UNSCANNED';

const file = (path: string, source: string): SourceFile => ({ path, source });
const declared = (table: string, path = 'packages/auth/src/tables.ts'): DeclaredTable => ({
  table,
  file: path,
  line: 1,
});

// Every test below scans the whole tree, so the budget is the file's default rather than a third
// argument per test — see `REPO_SCAN_TIMEOUT_MS`. This file ran on Bun's 5000ms default until
// 2026-08-27 and went red on a runtime 1.3x slower, which is less than one noisy CI runner.
setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

describe('what counts as a declared framework table', () => {
  test('a literal name is read, `if not exists` or not', () => {
    expect(
      declaredTables([
        file(
          'packages/a/src/one.ts',
          'export const A = `create table if not exists x_users (\nid text)`;',
        ),
        file('packages/a/src/two.ts', 'export const B = `create table x_audit (\nid text)`;'),
      ]).map((one) => one.table),
    ).toEqual(['x_users', 'x_audit']);
  });

  test('the line is the `create table`, not the file', () => {
    const found = declaredTables([
      file('packages/a/src/one.ts', '\n\n\nexport const A = `create table x_jobs (\nid text)`;'),
    ]);
    expect(found[0]?.line).toBe(4);
  });

  test('an INTERPOLATED name is not a framework table — it is the app naming its own', () => {
    // `@ultimat3/ai`'s `ddlSql(target)` and `@ultimat3/db`'s generator both build `create table`
    // for a relation the caller chose. Neither can be applied at boot, and reporting them would
    // make the rule un-satisfiable rather than useful.
    expect(
      declaredTables([
        // Built by concatenation so the fixture is not itself a template-literal lint finding —
        // the point is what the SCANNED source says, not how this file spells it.
        file(
          'packages/ai/src/pg-vector-sql.ts',
          `const ddl = \`create table if not exists $${'{'}target} (id text)\`;`,
        ),
        file(
          'packages/db/src/generate.ts',
          `const ddl = \`create table $${'{'}quote(name)} ($${'{'}cols})\`;`,
        ),
      ]),
    ).toEqual([]);
  });

  test('a test, a fixture and a CLI template declare nothing the framework must apply', () => {
    // The template case is the one measured false positive: `packages/cli/src/templates/guard.ts`
    // holds a `create table posts` that is a SCAFFOLDED app's first migration, written by the CLI
    // and never run by it.
    expect(
      declaredTables([
        file('packages/a/src/one.test.ts', 'const x = `create table x_ghost (id text)`;'),
        file('packages/a/src/thing-fixture.ts', 'const x = `create table x_ghost (id text)`;'),
        file('packages/cli/src/templates/guard.ts', 'const x = `create table posts (id text)`;'),
      ]),
    ).toEqual([]);
  });
});

describe('the rule', () => {
  test('a declared table no FRAMEWORK_SCHEMA row creates is reported, at its line', () => {
    const findings = checkFrameworkTables({
      declared: [{ table: 'x_users', file: 'packages/auth/src/tables.ts', line: 28 }],
      applied: ['x_jobs'],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe(UNAPPLIED);
    expect(findings[0]?.at).toBe('packages/auth/src/tables.ts:28');
    expect(findings[0]?.fix).toContain('packages/cli/src/framework-schema.ts');
    expect(findings[0]?.fix).toContain('packages/auth');
  });

  test('a declared table a row creates is silence', () => {
    expect(checkFrameworkTables({ declared: [declared('x_users')], applied: ['x_users'] })).toEqual(
      [],
    );
  });

  test('one table declared twice is reported once', () => {
    // The tree carries no double declaration today: `SQL_OUTBOX_TABLE` was the second copy of
    // `x_outbox` and it is deleted, which is why this case is synthetic. The rule outlives it —
    // two files may create one relation, and a per-site report would then count a table that HAS
    // an applier as two findings and send the next agent looking for a second migration.
    const findings = checkFrameworkTables({
      declared: [
        declared('x_outbox', 'packages/jobs/src/a.ts'),
        declared('x_outbox', 'packages/jobs/src/b.ts'),
      ],
      applied: ['x_jobs'],
    });
    expect(findings).toHaveLength(1);
  });

  test('case does not decide the verdict', () => {
    expect(checkFrameworkTables({ declared: [declared('x_users')], applied: ['X_USERS'] })).toEqual(
      [],
    );
  });

  test('an empty FRAMEWORK_SCHEMA is UNSCANNED, never a clean tree', () => {
    const findings = checkFrameworkTables({ declared: [declared('x_users')], applied: [] });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe(UNSCANNED);
  });

  test('an empty scan is UNSCANNED, never a clean tree', () => {
    const findings = checkFrameworkTables({ declared: [], applied: ['x_jobs'] });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe(UNSCANNED);
  });
});

describe('the real tree', () => {
  test('every framework table a package declares is created by a FRAMEWORK_SCHEMA row', async () => {
    const found = declaredTables(await collectSourceFiles(repoRoot()));
    // Non-vacuity, both halves: a scan that found nothing, or a schema that applied nothing,
    // would make the assertion below pass on a tree where nothing is applied at all.
    expect(found.length).toBeGreaterThan(10);
    const applied = FRAMEWORK_SCHEMA.flatMap((entry) => entry.tables);
    expect(applied.length).toBeGreaterThan(10);
    expect(checkFrameworkTables({ declared: found, applied })).toEqual([]);
  });

  test("auth's five tables are declared AND applied — the defect that shipped in every release", async () => {
    // Named individually rather than counted: the count moving is what a future edit is allowed
    // to do, and these five going missing is what it is not.
    const found = new Set(
      declaredTables(await collectSourceFiles(repoRoot())).map((one) => one.table),
    );
    const applied = new Set(FRAMEWORK_SCHEMA.flatMap((entry) => entry.tables));
    for (const table of ['x_users', 'x_sessions', 'x_accounts', 'x_verifications', 'x_api_keys']) {
      expect(found.has(table), `${table} is declared`).toBe(true);
      expect(applied.has(table), `${table} is applied at boot`).toBe(true);
    }
  });
});
