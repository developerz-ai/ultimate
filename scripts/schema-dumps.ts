#!/usr/bin/env bun
// Refuse a tracked app whose committed schema dump is not what its migrations and the framework's
// own tables produce — and, without `--check`, regenerate every one of them. A framework table is
// in every app's `packages/db/schema/framework/`, so one edited `create table` in a package stales
// every tracked app at once, and each app's own `drift` step only says so one app at a time.
//
// The apps are `GATED_APPS` (`scripts/lib/gated-apps.ts`), never a second list. Run it after any
// change to a framework table's DDL.
//
//   bun run schema-dumps [--check] [--json]

// why: host-separator path from the repo root to each app; Bun ships no path API.
import { join } from 'node:path';
import { checkSchemaDump, refreshSchemaDump, SCHEMA_DUMP_DIR } from '@ultimat3/cli';
import { flagBool, parseScriptArgs } from './lib/args';
import { GATED_APPS } from './lib/gated-apps';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

const SCRIPT = 'schema-dumps';
const WRITE = 'bun run schema-dumps';

/** What one app's dump needed, as the two modes report it. */
export interface AppDump {
  readonly app: string;
  /** Files written or deleted (regenerate), or files that differ (`--check`). */
  readonly changed: readonly string[];
  readonly findings: readonly Finding[];
}

/** The two verbs, injected so the rules below are testable with no database booted. */
export interface DumpVerbs {
  readonly check: (root: string) => Promise<readonly Finding[]>;
  readonly refresh: (root: string) => Promise<{
    readonly written: readonly string[];
    readonly removed: readonly string[];
    readonly finding?: Finding | undefined;
  }>;
}

const VERBS: DumpVerbs = {
  check: (root) => checkSchemaDump(root),
  refresh: (root) => refreshSchemaDump(root),
};

/**
 * One finding per stale app, never one per file: the repair is one command for the whole tree,
 * and sixty lines naming sixty files under it is a wall. The first file is named so the reader
 * can see WHAT moved; `at` is the app.
 */
export function staleDump(app: string, differences: readonly Finding[]): Finding {
  const first = differences[0];
  return {
    code: 'X_SCHEMA_DUMP_DRIFT',
    cause: `${app}/${SCHEMA_DUMP_DIR} is not what its migrations and the framework's tables produce — ${differences.length} difference(s), the first: ${first?.cause ?? 'unknown'}`,
    fix: `${WRITE}   # regenerates every tracked app's dump; commit what it writes`,
    at: app,
  };
}

/** `--check`: every app, even after the first stale one — the fix is one command for all of them. */
export async function checkDumps(
  root: string,
  apps: readonly string[],
  verbs: DumpVerbs = VERBS,
): Promise<readonly AppDump[]> {
  const out: AppDump[] = [];
  for (const app of apps) {
    const differences = await verbs.check(join(root, app));
    out.push({
      app,
      changed: differences.flatMap((finding) => (finding.at === undefined ? [] : [finding.at])),
      findings: differences.length === 0 ? [] : [staleDump(app, differences)],
    });
  }
  return out;
}

/**
 * Regenerate. A replay that fails is the app's own finding, carried through with the app named:
 * it is not staleness, and this script's command would not repair it.
 */
export async function writeDumps(
  root: string,
  apps: readonly string[],
  verbs: DumpVerbs = VERBS,
): Promise<readonly AppDump[]> {
  const out: AppDump[] = [];
  for (const app of apps) {
    const refresh = await verbs.refresh(join(root, app));
    out.push({
      app,
      changed: [...refresh.written, ...refresh.removed.map((file) => `- ${file}`)],
      findings: refresh.finding === undefined ? [] : [{ ...refresh.finding, at: app }],
    });
  }
  return out;
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const check = flagBool(args, 'check');
  const apps = GATED_APPS.map((app) => app.dir);
  const dumps = await (check ? checkDumps : writeDumps)(repoRoot(), apps);
  const findings = dumps.flatMap((dump) => dump.findings);
  const moved = dumps.filter((dump) => dump.changed.length > 0);
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      summary:
        findings.length > 0
          ? `${findings.length} of ${apps.length} tracked app(s) ${check ? 'hold a stale schema dump' : 'could not be regenerated'}`
          : check
            ? `${apps.length} tracked app(s) hold the schema dump their migrations produce`
            : moved.length === 0
              ? `${apps.length} tracked app(s) regenerated — nothing changed`
              : `${moved.length} of ${apps.length} tracked app(s) regenerated with changes — commit them`,
      findings,
      data: dumps.map((dump) => ({ app: dump.app, changed: dump.changed })),
      lines: check
        ? []
        : moved.flatMap((dump) => dump.changed.map((file) => `  ${dump.app}/${file}`)),
    },
    args.json,
  );
}
