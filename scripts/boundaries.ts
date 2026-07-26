#!/usr/bin/env bun
// Enforce the tier table across packages/*/src as a BUILD ERROR, not a lint warning (axiom 3).
// A package may import only from a strictly lower tier; sideways within a tier and upward are
// both failures, and the report names the file, the import and the tiers that were allowed.
//
//   bun run scripts/boundaries.ts [--json] [--package cli]

import { join } from 'node:path';
import { parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { allowedTiersFor, checkTier, tierOf } from './lib/tiers';

export interface SourceFile {
  /** Path relative to the repo root, POSIX separators. */
  readonly path: string;
  readonly source: string;
}

export interface Violation {
  readonly file: string;
  readonly from: string;
  readonly to: string;
  readonly fromTier: number;
  readonly toTier: number;
  readonly reason: string;
  readonly allowedTiers: string;
}

const SCOPE = '@ultimat3/';

/** `packages/cli/src/cmd-db.ts` -> `cli`. Anything else is not a framework package. */
export function packageOf(path: string): string | undefined {
  const match = /^packages\/([^/]+)\//.exec(path);
  return match?.[1];
}

export const scopedName = (specifier: string): string | undefined =>
  specifier.startsWith(SCOPE)
    ? (specifier.slice(SCOPE.length).split('/')[0] ?? undefined)
    : undefined;

/** The transpiler rejects a shebang, and `bin.ts` legitimately has one. */
export const stripShebang = (source: string): string =>
  source.startsWith('#!') ? source.slice(source.indexOf('\n') + 1) : source;

/** Bun's transpiler is the parser: type-only imports are erased, dynamic imports are included. */
export function importsOf(file: SourceFile): readonly string[] {
  const loader = file.path.endsWith('x') ? 'tsx' : 'ts';
  return new Bun.Transpiler({ loader })
    .scanImports(stripShebang(file.source))
    .map((entry) => entry.path);
}

/**
 * Pure. Callers do the I/O, so a test can hand this a fixture import graph and assert on the
 * violation report without writing a single file.
 */
export function checkBoundaries(files: readonly SourceFile[]): readonly Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const from = packageOf(file.path);
    if (from === undefined) continue;
    for (const specifier of importsOf(file)) {
      const to = scopedName(specifier);
      if (to === undefined || to === from) continue;
      const verdict = checkTier(from, to);
      if (verdict.allowed) continue;
      violations.push({
        file: file.path,
        from,
        to,
        fromTier: tierOf(from),
        toTier: tierOf(to),
        reason: verdict.reason,
        allowedTiers: allowedTiersFor(from),
      });
    }
  }
  return violations;
}

const REASON_CAUSE: Readonly<Record<string, string>> = {
  'same-tier': 'sideways import inside the same tier',
  upward: 'import from a higher tier',
  'unknown-package': 'import of a package that is not in the tier table',
};

export function findingFor(violation: Violation): Finding {
  const cause =
    `${violation.from} (tier ${violation.fromTier}) imports @ultimat3/${violation.to} ` +
    `(tier ${violation.toTier}) — ${REASON_CAUSE[violation.reason] ?? violation.reason}; ` +
    `allowed tiers: ${violation.allowedTiers}`;
  return {
    code: 'X_BOUNDARY_VIOLATION',
    cause,
    fix:
      violation.reason === 'unknown-package'
        ? `add "${violation.to}" to the tier table in scripts/lib/tiers.ts, or drop the import`
        : `move the shared code down to a lower tier, or invert the dependency and pass it in`,
    at: violation.file,
  };
}

export async function collectSourceFiles(root: string): Promise<readonly SourceFile[]> {
  const glob = new Bun.Glob('packages/*/src/**/*.{ts,tsx}');
  const files: SourceFile[] = [];
  for await (const path of glob.scan({ cwd: root, absolute: false })) {
    if (path.includes('node_modules')) continue;
    const posix = path.split('\\').join('/');
    files.push({ path: posix, source: await Bun.file(join(root, posix)).text() });
  }
  return files;
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const only = args.flags.get('package');
  const files = (await collectSourceFiles(root)).filter(
    (file) => typeof only !== 'string' || packageOf(file.path) === only,
  );
  const violations = checkBoundaries(files);
  report(
    {
      ok: violations.length === 0,
      script: 'boundaries',
      summary:
        violations.length === 0
          ? `${files.length} files, no tier violations`
          : `${violations.length} tier violation(s) across ${files.length} files`,
      findings: violations.map(findingFor),
      data: { files: files.length, violations },
    },
    args.json,
  );
}
