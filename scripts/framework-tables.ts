#!/usr/bin/env bun
// Enforce, as a ratchet, that every framework table a package DECLARES is a table some boot path
// CREATES — `FRAMEWORK_SCHEMA` in `@ultimat3/cli` being the one applier the framework has.
//
// THE DEFECT THIS EXISTS FOR. `packages/auth/src/tables.ts` declares `x_users`, `x_sessions`,
// `x_accounts`, `x_verifications` and `x_api_keys` — the five relations `BuiltinAdapter` reads —
// and until 2026-08-24 NOTHING created them, in dev or in production — from the initial commit
// through all 21 released versions. They are not `entity()`
// declarations, so `x db gen` never saw them; the file exported the DDL "so an app can paste it
// into a migration", and no app did. `examples/dummy/CLAUDE.md` recorded the consequence in the
// app's own words — nobody could hold a session — without anyone connecting it to the cause. Every
// release, a green gate throughout.
//
// It is the same shape as `jobs.driver`, which typed three values, had no reader, and silently
// gave you Postgres: a DECLARATION nothing reads. `scripts/config-readers.ts` mechanised that half
// for `AppConfig` keys and `scripts/declaration-readers.ts` for declaration roots; a `create table`
// no boot runs is the third face of it, and the one that fails in production rather than at boot.
//
// WHY A LITERAL NAME ONLY. A table whose name is INTERPOLATED is the app's, by construction —
// `@ultimat3/ai`'s `ddlSql(target)` takes the relation and the dimension from the caller, and
// `@ultimat3/db`'s generator BUILDS `create table` for an app's entities out of a diff. Neither is
// a framework table and neither can be applied at boot. A literal name is the framework naming its
// own relation, and that is the only thing this rule reads.
//
// WHY THE TEMPLATE DIRECTORY IS SKIPPED. `packages/cli/src/templates/` is source the CLI WRITES,
// never source it runs — `guard.ts` holds a `create table posts` that belongs to a scaffolded
// app's first migration. Scanning it reports a table the framework must never create.
//
//   bun run framework-tables  ·  bun run scripts/framework-tables.ts [--json] [--explain]

import { FRAMEWORK_SCHEMA } from '@ultimat3/cli';
import { collectSourceFiles, type SourceFile } from './boundaries';
import { parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { isTestPath, lineOf } from './lib/source-scan';
import { packageOf } from './test-fix-citations';

const SCRIPT = 'framework-tables';

/**
 * Source the CLI EMITS rather than executes. A path prefix, not a name test: everything under it
 * is a template by construction, and a template that happened to be named like a module would
 * otherwise be scanned.
 */
const TEMPLATE_ROOT = 'packages/cli/src/templates/';

/** A generated fixture is a test's input; it declares nothing the framework must apply. */
const isFixture = (path: string): boolean => /-fixture\.tsx?$/.test(path);

/**
 * `create table if not exists x_users (` -> `x_users`. Case-insensitive because the DDL in this
 * tree is written lower-case and Postgres does not care; the NAME is lower-cased before comparison
 * for the same reason.
 *
 * A quoted or interpolated name matches nothing here on purpose — see the header.
 */
const CREATE_TABLE = /create\s+table\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z_0-9]*)\s*\(/gi;

export interface DeclaredTable {
  readonly table: string;
  readonly file: string;
  readonly line: number;
}

/** Every literal relation name a shipped module names in a `create table`. */
export function declaredTables(files: readonly SourceFile[]): readonly DeclaredTable[] {
  const found: DeclaredTable[] = [];
  for (const file of files) {
    if (isTestPath(file.path) || isFixture(file.path) || file.path.startsWith(TEMPLATE_ROOT)) {
      continue;
    }
    for (const match of file.source.matchAll(CREATE_TABLE)) {
      const table = (match[1] as string).toLowerCase();
      found.push({ table, file: file.path, line: lineOf(file.source, match.index) });
    }
  }
  return found;
}

export interface FrameworkTableInput {
  readonly declared: readonly DeclaredTable[];
  /** Every table name `FRAMEWORK_SCHEMA` creates. Empty is a failure, never a clean answer. */
  readonly applied: readonly string[];
}

/**
 * One rule, one direction: a declared table with no applier is a finding. The reverse — an applied
 * table no module declares — is NOT checked here, because `framework-schema.test.ts` already
 * asserts that every row creates exactly the tables it claims, against the DDL itself.
 */
export function checkFrameworkTables(input: FrameworkTableInput): readonly Finding[] {
  if (input.applied.length === 0) {
    return [
      {
        code: 'X_FRAMEWORK_TABLE_UNSCANNED',
        cause:
          'FRAMEWORK_SCHEMA names no table, so every declared table would have read as unapplied',
        fix: 'restore FRAMEWORK_SCHEMA in packages/cli/src/framework-schema.ts — `bun run x -- db migrate --json` applies it',
        at: 'packages/cli/src/framework-schema.ts',
      },
    ];
  }
  if (input.declared.length === 0) {
    return [
      {
        code: 'X_FRAMEWORK_TABLE_UNSCANNED',
        cause: 'no `create table` was found in packages/*/src, so this rule read nothing',
        fix: 'run `bun run scripts/framework-tables.ts` from the repo root',
        at: 'scripts/framework-tables.ts',
      },
    ];
  }
  const applied = new Set(input.applied.map((name) => name.toLowerCase()));
  const findings: Finding[] = [];
  const reported = new Set<string>();
  for (const entry of input.declared) {
    if (applied.has(entry.table) || reported.has(entry.table)) continue;
    reported.add(entry.table);
    const at = `${entry.file}:${String(entry.line)}`;
    findings.push({
      code: 'X_FRAMEWORK_TABLE_UNAPPLIED',
      cause: `${at} declares the framework table ${entry.table} and no boot path creates it — FRAMEWORK_SCHEMA does not name it`,
      fix: `add ${entry.table} to a FRAMEWORK_SCHEMA row in packages/cli/src/framework-schema.ts, with the DDL constant packages/${packageOf(entry.file) ?? '<pkg>'} exports, so every boot creates it — or delete the declaration at ${at} if the table is the app's to create`,
      at,
    });
  }
  return findings;
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const declared = declaredTables(await collectSourceFiles(repoRoot()));
  const applied = FRAMEWORK_SCHEMA.flatMap((entry) => entry.tables);
  const findings = checkFrameworkTables({ declared, applied });
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      // The UNSCANNED case is not a count of unapplied tables — it is the rule saying it read
      // nothing, and a summary that calls it "1 table" reads as a small problem instead of a
      // blind rule. Every other ratchet here makes that distinction; so does this one.
      summary:
        findings.length === 0
          ? `${String(new Set(declared.map((one) => one.table)).size)} framework table(s) declared across packages/*/src, every one created by a FRAMEWORK_SCHEMA row`
          : findings[0]?.code === 'X_FRAMEWORK_TABLE_UNSCANNED'
            ? 'this rule read nothing, so no framework table was checked'
            : `${String(findings.length)} framework table(s) a package declares and no boot path creates`,
      findings,
      data: {
        declared: args.flags.get('explain') === true ? declared : declared.length,
        applied,
      },
    },
    args.json,
  );
}
