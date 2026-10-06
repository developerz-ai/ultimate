#!/usr/bin/env bun

// Enforce that a host `relative()` answer is written POSIX through `toPosix` before it is used.
//
// `node:path`'s `relative` answers in the host's separator. On Windows a `\` reached an import
// specifier (`x fix` wrote `import '..\\foo'`, which no Linux teammate resolves), a `fix:` line
// and a sort key (plan 101 sweep 8b, W13). `packages/cli/src/posix-path.ts` holds the one
// conversion: `toPosix(relative(…))` or `posixRelative(…)`.
//
// WHAT COUNTS: in `packages/*/src` (tests aside), every call of a `relative` imported from
// `node:path` — named, aliased, or `<name>.relative` off `import * as` or a default import — that is not the
// direct argument of `toPosix(`. `node:path/posix` is not counted: its answer is POSIX already.
// NARROWER THAN THE RULE, and said so: a data-flow guard would follow the answer to the specifier
// or the fix it reaches; this one asks of every call. A call whose answer only ever reaches the
// filesystem says so on its own line or the line above, `// native-path: <why>`.
//
// PINNED: the sites the sweep did not reach are `BACKLOG`, one count per file. A count may only
// fall; a file that goes clean must leave the table in the same diff (a stale pin is a finding).
//
//   bun run posix-relative  ·  bun run scripts/posix-relative.ts [--json]

import { parseScriptArgs } from './lib/args';
import { corpus } from './lib/corpus';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { isTestPath, lineOf } from './lib/source-scan';

const SCRIPT = 'posix-relative';
const CODE = 'X_RELATIVE_PATH_NOT_POSIX';

/** The helper itself: it is where the conversion lives. */
const EXEMPT: ReadonlySet<string> = new Set(['packages/cli/src/posix-path.ts']);

/** Unwrapped calls per file, as of the sweep that landed this rule. Only ever shrinks. */
export const BACKLOG: Readonly<Record<string, number>> = {
  'packages/cli/src/affected.ts': 1,
  'packages/cli/src/cmd-new.ts': 1,
  'packages/cli/src/cmd-shot-matrix.ts': 1,
  'packages/cli/src/db-seed.ts': 1,
  'packages/cli/src/duplicate-packages.ts': 1,
  'packages/cli/src/flag-reads.ts': 1,
  'packages/cli/src/gitignore.ts': 1,
  'packages/cli/src/island-bundle.ts': 1,
  'packages/cli/src/island-sources.ts': 1,
  'packages/cli/src/island-states-load.ts': 1,
  'packages/cli/src/island-store.ts': 1,
  'packages/cli/src/prerender-out.ts': 1,
  'packages/cli/src/root-env.ts': 1,
  'packages/cli/src/worker-bundle.ts': 1,
};

const NAMED = /import\s*\{([^}]*)\}\s*from\s*['"]node:path['"]/g;
const NAMESPACE = /import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s*['"]node:path['"]/g;
/** `import path from 'node:path'`, alone or ahead of `{ … }` — the module object, as `* as` is. */
const DEFAULT =
  /import\s+(?!type\b)([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\}\s*)?from\s*['"]node:path['"]/g;
const WAIVER = /\/\/\s*native-path:\s*\S/;

export interface RelativeSite {
  readonly path: string;
  readonly line: number;
}

/** The call spellings that mean `node:path`'s `relative` in this file. */
function callees(source: string): readonly string[] {
  const names: string[] = [];
  for (const match of source.matchAll(NAMED)) {
    for (const part of (match[1] ?? '').split(',')) {
      const spec = part.trim().replace(/^type\s+/, '');
      const alias = /^relative(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(spec);
      if (alias !== null) names.push(alias[1] ?? 'relative');
    }
  }
  for (const match of source.matchAll(NAMESPACE)) names.push(`${match[1]}.relative`);
  for (const match of source.matchAll(DEFAULT)) names.push(`${match[1]}.relative`);
  return names;
}

/** Every unwrapped, unwaived `relative(` call in one file, by line. `masked` blanks comments and strings. */
export function scanRelative(
  path: string,
  source: string,
  masked: string,
): readonly RelativeSite[] {
  const lines = source.split('\n');
  const sites: RelativeSite[] = [];
  for (const callee of callees(source)) {
    const escaped = callee.replace(/[$.]/g, (char) => `\\${char}`);
    for (const call of masked.matchAll(new RegExp(`(?<![\\w$.])${escaped}\\s*\\(`, 'g'))) {
      if (/\btoPosix\s*\(\s*$/.test(masked.slice(Math.max(0, call.index - 40), call.index))) {
        continue;
      }
      const line = lineOf(source, call.index);
      if (WAIVER.test(lines[line - 1] ?? '') || WAIVER.test(lines[line - 2] ?? '')) continue;
      sites.push({ path, line });
    }
  }
  return sites.sort((a, b) => a.line - b.line);
}

const fix = (path: string): string =>
  `edit ${path}: wrap the call as toPosix(relative(…)) — or posixRelative(…) — from packages/cli/src/posix-path.ts, or mark a filesystem-only answer // native-path: <why>`;

/** Findings for the scanned sites against the pinned table. */
export function relativeFindings(sites: readonly RelativeSite[]): readonly Finding[] {
  const counts = new Map<string, RelativeSite[]>();
  for (const site of sites) counts.set(site.path, [...(counts.get(site.path) ?? []), site]);
  const findings: Finding[] = [];
  for (const [path, found] of [...counts].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const pinned = Object.hasOwn(BACKLOG, path) ? (BACKLOG[path] ?? 0) : 0;
    if (found.length <= pinned) continue;
    const first = found[0] as RelativeSite;
    findings.push({
      code: CODE,
      cause: `${path}:${String(first.line)} uses relative() from node:path without toPosix — ${String(found.length)} call(s), ${String(pinned)} pinned — so a Windows run writes a \\ into the specifier, fix or key it reaches`,
      fix: fix(path),
      at: `${path}:${String(first.line)}`,
    });
  }
  for (const [path, pinned] of Object.entries(BACKLOG)) {
    const now = counts.get(path)?.length ?? 0;
    if (now >= pinned) continue;
    findings.push({
      code: CODE,
      cause: `${path} is pinned at ${String(pinned)} unwrapped relative() call(s) and now has ${String(now)} — the pin is stale`,
      fix: `bun run posix-relative --json   # after setting BACKLOG['${path}'] to ${String(now)} in scripts/posix-relative.ts, or deleting the row at 0`,
      at: path,
    });
  }
  return findings;
}

/** Every site in the framework's package sources. */
export async function relativeSites(root: string): Promise<readonly RelativeSite[]> {
  const files = await corpus(root, 'packages');
  return files
    .filter((file) => !isTestPath(file.path) && !EXEMPT.has(file.path))
    .flatMap((file) => scanRelative(file.path, file.source, file.masked));
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const findings = relativeFindings(await relativeSites(repoRoot()));
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      summary:
        findings.length === 0
          ? 'every relative() answer from node:path is written POSIX through toPosix'
          : `${String(findings.length)} file(s) use relative() from node:path without toPosix`,
      findings,
    },
    args.json,
  );
}
