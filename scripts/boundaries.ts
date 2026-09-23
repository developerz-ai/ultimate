#!/usr/bin/env bun
// Enforce the repo's import rules as BUILD ERRORS, not lint warnings (axiom 3). Four rules in one
// script, because every one of them is answered by reading source and none needs a type-checker.
//
//   1. The tier CEILING across `packages/*/src`: a package may import only from a strictly lower
//      tier. Sideways within a tier and upward are both failures, and the report names the file,
//      the import and the tiers that were allowed.
//   2. The tier FLOOR: a package sitting ABOVE the lowest tier its own imports allow needs a
//      written reason in `FLOOR_ABOVE` (`scripts/lib/tiers.ts`), which is the half that did not
//      exist until 2026-08-22 while that file claimed it did.
//   3. The leaf rule across an example app's `shared/`: a leaf may name an `app/` or `site/`
//      type, never load its module.
//   4. `@ultimat3/admin`'s one-flattener rule: one file may read `$meta`/`$describe()`.
//
// The scan is `packages/cli/src/import-scan.ts`, a leaf read by path — the ONE import scanner, which
// `workspace-graph.ts` reads too. It was a second regex scanner there until #493 showed the two
// disagreeing on a template nested in a substitution.
//
//   bun run scripts/boundaries.ts [--json] [--package cli]

import { join } from 'node:path';
import { dirname, join as joinPosix, normalize } from 'node:path/posix';
import { scanAllImports, scanRuntimeImports } from '../packages/cli/src/import-scan';
import { parseScriptArgs } from './lib/args';
import { corpus } from './lib/corpus';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import {
  allowedImportsFor,
  checkFloors,
  checkTier,
  FLOOR_ABOVE,
  floorFindingFor,
  tierOf,
} from './lib/tiers';

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

/**
 * Which framework package a specifier reaches, however it is spelled. A RELATIVE path that leaves
 * its own package is a cross-package import wearing a costume — `packages/cli/src/x.test.ts`
 * importing `../../testing/src/sealed-network` is `cli -> testing`, and reading only `@ultimat3/…`
 * meant any package could step outside its tier by writing `../../<pkg>/src/…` instead.
 */
export function targetPackage(fromFile: string, specifier: string): string | undefined {
  if (specifier.startsWith(SCOPE)) return scopedName(specifier);
  if (!specifier.startsWith('.')) return undefined;
  return packageOf(`${normalize(joinPosix(dirname(fromFile), specifier))}/`);
}

/**
 * Every specifier the file names, type-only ones included — `import-scan.ts`'s `scanAllImports`,
 * the one scanner the CLI's workspace rule reads too. The tier rule applies to both halves: a
 * type-only edge still couples two packages' release cycles. Memoised per file OBJECT: the corpus
 * hands every rule the same objects, and the ceiling and the floor both ask.
 */
export function allImportsOf(file: SourceFile): readonly string[] {
  const hit = scanned.get(file);
  if (hit !== undefined) return hit;
  let found: readonly string[];
  try {
    found = scanAllImports(file);
  } catch {
    // A file the parser refuses is typecheck's to report; this rule reads what it can.
    found = [];
  }
  scanned.set(file, found);
  return found;
}

const scanned = new WeakMap<SourceFile, readonly string[]>();

/**
 * Pure. Callers do the I/O, so a test can hand this a fixture import graph and assert on the
 * violation report without writing a single file.
 */
export function checkBoundaries(files: readonly SourceFile[]): readonly Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const from = packageOf(file.path);
    if (from === undefined) continue;
    for (const specifier of allImportsOf(file)) {
      const to = targetPackage(file.path, specifier);
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
        allowedTiers: allowedImportsFor(from),
      });
    }
  }
  return violations;
}

/** The floor rule over an already-collected scan, so no caller reads the tree twice for it. */
export const floorFindings = (files: readonly SourceFile[]): readonly Finding[] =>
  checkFloors(packageEdges(files), FLOOR_ABOVE).map(floorFindingFor);

/**
 * Every framework package each package imports, read from the same files and the same specifiers
 * the tier rule is judged on — so the FLOOR a package is held to can never be computed from a
 * different set of edges than the CEILING it is already checked against.
 */
export function packageEdges(
  files: readonly SourceFile[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const edges = new Map<string, Set<string>>();
  for (const file of files) {
    const from = packageOf(file.path);
    if (from === undefined) continue;
    const targets = edges.get(from) ?? new Set<string>();
    edges.set(from, targets);
    for (const specifier of allImportsOf(file)) {
      const to = targetPackage(file.path, specifier);
      if (to !== undefined && to !== from) targets.add(to);
    }
  }
  return edges;
}

const REASON_CAUSE: Readonly<Record<string, string>> = {
  'same-tier': 'sideways import inside the same tier',
  upward: 'import from a higher tier',
  'edge-only': 'import outside this package’s declared edges',
  'unknown-package': 'import of a package that is not in the tier table',
};

const DEFAULT_BOUNDARY_FIX =
  'move the shared code down to a lower tier, or invert the dependency and pass it in';

/** One runnable edit per reason. `edge-only` names the map entry, because for that package the
 * declared edge IS the whole allowance — there is no lower tier to move code down to. */
const fixFor = (violation: Violation): string => {
  if (violation.reason === 'unknown-package') {
    return `add "${violation.to}" to the tier table in scripts/lib/tiers.ts, or drop the import`;
  }
  if (violation.reason === 'edge-only') {
    return (
      `drop the import from ${violation.file}, or add "${violation.to}" to ` +
      `SIDEWAYS_ALLOW["${violation.from}"] in scripts/lib/tiers.ts with the line that earns it`
    );
  }
  return DEFAULT_BOUNDARY_FIX;
};

export function findingFor(violation: Violation): Finding {
  const cause =
    `${violation.from} (tier ${violation.fromTier}) imports @ultimat3/${violation.to} ` +
    `(tier ${violation.toTier}) — ${REASON_CAUSE[violation.reason] ?? violation.reason}; ` +
    `allowed: ${violation.allowedTiers}`;
  return {
    code: 'X_BOUNDARY_VIOLATION',
    cause,
    fix: fixFor(violation),
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

/**
 * `src/` is not all of a package's source: three packages carry an `e2e` directory beside it, and
 * `scripts/**` is in `@ultimat3/cli`'s `SOURCE_GLOBS`, so both halves of the `errors` step see the
 * same files. The set is `corpus.ts`'s `source` scope — read once per process, and refused below
 * its floor rather than answered with "no boundary violations" over nothing.
 */
export const collectSourceFiles = (root: string): Promise<readonly SourceFile[]> =>
  corpus(root, 'source');

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
 * Pure, like `checkBoundaries`. `scanRuntimeImports` is Bun's transpiler, so `import type` is already gone
 * by the time this sees a specifier — which is precisely the line the rule draws: naming an
 * `app/` type from a leaf is legal, loading its module is not.
 */
export function checkSharedLeaf(files: readonly SourceFile[]): readonly SharedLeafViolation[] {
  const violations: SharedLeafViolation[] = [];
  for (const file of files) {
    if (surfaceOf(file.path) !== 'shared') continue;
    for (const specifier of scanRuntimeImports(file)) {
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
/**
 * The two roots this repo tracks an app under. One fact, stated once: `scripts/async-context-guard.ts`
 * asks the same question over the same roots, and an app added under either should enter both rules
 * by existing rather than by someone remembering a second glob.
 *
 * The demo app under `dummy/` is the one CI publishes an image for on every push to main, and the
 * header's reason for checking these rules here — that the app gate runs advisory-only — applies to
 * it verbatim. Its 8 `shared/` modules were checked by nothing.
 */
export const APP_ROOTS = '{examples,dummy}';

export async function collectSharedFiles(root: string): Promise<readonly SourceFile[]> {
  const files = await readFiles(root, `${APP_ROOTS}/*/apps/*/shared/**/*.{ts,tsx}`);
  return files.filter((file) => !file.path.includes('.test.'));
}

// ---------------------------------------------------------------------------
// Rule 3: `@ultimat3/admin`'s one-flattener rule (`packages/admin/CLAUDE.md`) — `entity-columns.ts`
// is the only file that may read `$meta` or call `$describe()`; every other admin module takes the
// already-flattened `AdminColumnFacts` instead, so a new column kind derives in one place. Stated
// in the package's CLAUDE.md since it shipped; enforced here because axiom 3 (a convention that is
// not a build error does not exist) applies to a package's own internal seams too, not just tiers.
// ---------------------------------------------------------------------------

const ADMIN_FLATTENER_FILE = 'packages/admin/src/entity-columns.ts';

/** `registry.ts` only *declares* `$meta`/`$describe` as interface members — it never reads them;
 * excluded by name so a future reformatting of that declaration can't accidentally read as a
 * violation of a rule it is not subject to. */
const ADMIN_FLATTENER_EXEMPT = new Set([ADMIN_FLATTENER_FILE, 'packages/admin/src/registry.ts']);

/** A leading `.` is what makes this a read (`column.$meta`, `entity.$describe()`) rather than an
 * interface member declaration (`readonly $meta: …`, `$describe(): …`), which has none. */
const ADMIN_FLATTENER_PATTERN = /\.\$meta\b|\.\$describe\s*\(/;

export interface AdminFlattenerViolation {
  readonly file: string;
}

/** Pure, like the checks above. */
export function checkAdminFlattener(
  files: readonly SourceFile[],
): readonly AdminFlattenerViolation[] {
  return files
    .filter((file) => !ADMIN_FLATTENER_EXEMPT.has(file.path) && !file.path.includes('.test.'))
    .filter((file) => ADMIN_FLATTENER_PATTERN.test(file.source))
    .map((file) => ({ file: file.path }));
}

export function adminFlattenerFindingFor(violation: AdminFlattenerViolation): Finding {
  return {
    code: 'X_ADMIN_FLATTENER_VIOLATION',
    cause:
      `${violation.file} reads $meta or calls $describe() directly — ${ADMIN_FLATTENER_FILE} is ` +
      'the one file @ultimat3/admin lets flatten an entity onto AdminColumnFacts',
    fix: `take AdminColumnFacts from entity-columns.ts instead of reading $meta/$describe() in ${violation.file}`,
    at: violation.file,
  };
}

/**
 * `.tsx` as well as `.ts`, `As of 2026-09-06`. `@ultimat3/admin` is a COMPONENT package — seven of
 * its modules are `.tsx`, `list.tsx` and `detail.tsx` among them — so a `.ts`-only glob read every
 * file except the screens that render a column, which is the file class most likely to flatten an
 * entity onto `AdminColumnFacts` in the first place.
 */
export async function collectAdminFiles(root: string): Promise<readonly SourceFile[]> {
  return readFiles(root, 'packages/admin/src/**/*.{ts,tsx}');
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const only = args.flags.get('package');
  const everySource = await collectSourceFiles(root);
  const files = everySource.filter(
    (file) => typeof only !== 'string' || packageOf(file.path) === only,
  );
  const violations = checkBoundaries(files);
  // The floor rule reads the WHOLE tree even under `--package`, and is skipped when one is given: a
  // floor is a statement about one package's position among all of them, so a filtered scan answers
  // 0 for every package the filter dropped and reports the rest as stale rows.
  const floors =
    typeof only === 'string' ? [] : checkFloors(packageEdges(everySource), FLOOR_ABOVE);
  // `--package` narrows to one framework package; the leaf and flattener rules are each about one
  // fixed location (an app's `shared/`, `@ultimat3/admin`), not "whichever package was asked for".
  const sharedFiles = typeof only === 'string' ? [] : await collectSharedFiles(root);
  const leaks = checkSharedLeaf(sharedFiles);
  const adminFiles = typeof only === 'string' ? [] : await collectAdminFiles(root);
  const adminLeaks = checkAdminFlattener(adminFiles);
  const findings = [
    ...violations.map(findingFor),
    ...floors.map(floorFindingFor),
    ...leaks.map(sharedLeafFindingFor),
    ...adminLeaks.map(adminFlattenerFindingFor),
  ];
  const scanned = files.length + sharedFiles.length + adminFiles.length;
  report(
    {
      ok: findings.length === 0,
      script: 'boundaries',
      summary:
        findings.length === 0
          ? `${scanned} files, no boundary violations`
          : `${findings.length} boundary violation(s) across ${scanned} files`,
      findings,
      data: { files: scanned, violations, floors, leaks, adminLeaks },
    },
    args.json,
  );
}
