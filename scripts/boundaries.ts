#!/usr/bin/env bun
// Enforce the repo's import rules as BUILD ERRORS, not lint warnings (axiom 3). Two rules in one
// script, because both are answered by reading source through Bun's own transpiler — which is why
// this file imports no workspace package and the CI job that runs it needs no `bun install`.
//
//   1. The tier table across `packages/*/src`: a package may import only from a strictly lower
//      tier. Sideways within a tier and upward are both failures, and the report names the file,
//      the import and the tiers that were allowed.
//   2. The leaf rule across an example app's `shared/`: a leaf may name an `app/` or `site/`
//      type, never load its module.
//
//   bun run scripts/boundaries.ts [--json] [--package cli]

import { join } from 'node:path';
import { dirname, join as joinPosix, normalize } from 'node:path/posix';
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

async function readFiles(root: string, pattern: string): Promise<readonly SourceFile[]> {
  const glob = new Bun.Glob(pattern);
  const files: SourceFile[] = [];
  for await (const path of glob.scan({ cwd: root, absolute: false })) {
    if (path.includes('node_modules')) continue;
    const posix = path.split('\\').join('/');
    files.push({ path: posix, source: await Bun.file(join(root, posix)).text() });
  }
  return files;
}

export async function collectSourceFiles(root: string): Promise<readonly SourceFile[]> {
  return readFiles(root, 'packages/*/src/**/*.{ts,tsx}');
}

// ---------------------------------------------------------------------------
// Rule 2: `shared/` is a leaf.
//
// `@ultimat3/render`'s `checkSurfaceBoundary` states the same rule for a generated app (the CLI
// runs it from `packages/cli/src/app-boundaries.ts`), but it only ever runs from an app root
// under `x verify`, and CI runs the reference app's gate advisory-only — so a value import out
// of `shared/` would ship with nothing red. Checked here instead of imported from there because
// this script must keep running with no node_modules present.
// ---------------------------------------------------------------------------

const SURFACES = new Set(['site', 'app', 'api', 'shared']);

/** Surfaces a leaf may never reach at runtime. `api/` is types-only by a different rule. */
const CLOSED_TO_LEAF = new Set(['app', 'site']);

export interface SharedLeafViolation {
  readonly file: string;
  readonly specifier: string;
  /** The surface the specifier resolved into. */
  readonly surface: string;
}

/** `examples/dummy/apps/web/shared/client.ts` -> `shared`. Undefined outside any surface. */
export function surfaceOf(path: string): string | undefined {
  return path.split('/').find((part) => SURFACES.has(part));
}

/** Relative specifiers resolve against their importer, so the surface is readable from the path. */
export function resolveSpecifier(fromFile: string, specifier: string): string {
  if (!specifier.startsWith('.')) return specifier;
  return normalize(joinPosix(dirname(fromFile), specifier));
}

/**
 * Pure, like `checkBoundaries`. `importsOf` is Bun's transpiler, so `import type` is already gone
 * by the time this sees a specifier — which is precisely the line the rule draws: naming an
 * `app/` type from a leaf is legal, loading its module is not.
 */
export function checkSharedLeaf(files: readonly SourceFile[]): readonly SharedLeafViolation[] {
  const violations: SharedLeafViolation[] = [];
  for (const file of files) {
    if (surfaceOf(file.path) !== 'shared') continue;
    for (const specifier of importsOf(file)) {
      const surface = surfaceOf(resolveSpecifier(file.path, specifier));
      if (surface === undefined || !CLOSED_TO_LEAF.has(surface)) continue;
      violations.push({ file: file.path, specifier, surface });
    }
  }
  return violations;
}

export function sharedLeafFindingFor(violation: SharedLeafViolation): Finding {
  return {
    code: 'X_BOUNDARY_SHARED_LEAF',
    cause:
      `${violation.file} has a runtime import of "${violation.specifier}" from ` +
      `${violation.surface}/ — shared/ is a leaf, so that drags the ${violation.surface}/ ` +
      `module graph into every bundle that touches it`,
    fix: `make it \`import type\`, or pass the ${violation.surface}/ value in as an argument`,
    at: violation.file,
  };
}

/** Tests are excluded, as they are in `checkAppBoundaries`: a test is never bundled, and the leaf
 * rule exists to keep bundle graphs apart (axiom 6). */
export async function collectSharedFiles(root: string): Promise<readonly SourceFile[]> {
  const files = await readFiles(root, 'examples/*/apps/*/shared/**/*.{ts,tsx}');
  return files.filter((file) => !file.path.includes('.test.'));
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const only = args.flags.get('package');
  const files = (await collectSourceFiles(root)).filter(
    (file) => typeof only !== 'string' || packageOf(file.path) === only,
  );
  const violations = checkBoundaries(files);
  // `--package` narrows to one framework package; the leaf rule is about an app, not a package.
  const sharedFiles = typeof only === 'string' ? [] : await collectSharedFiles(root);
  const leaks = checkSharedLeaf(sharedFiles);
  const findings = [...violations.map(findingFor), ...leaks.map(sharedLeafFindingFor)];
  const scanned = files.length + sharedFiles.length;
  report(
    {
      ok: findings.length === 0,
      script: 'boundaries',
      summary:
        findings.length === 0
          ? `${scanned} files, no boundary violations`
          : `${findings.length} boundary violation(s) across ${scanned} files`,
      findings,
      data: { files: scanned, violations, leaks },
    },
    args.json,
  );
}
