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
import { allowedImportsFor, checkTier, tierOf } from './lib/tiers';

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

/** The transpiler rejects a shebang, and `bin.ts` legitimately has one. */
export const stripShebang = (source: string): string =>
  source.startsWith('#!') ? source.slice(source.indexOf('\n') + 1) : source;

/**
 * `scanImports` ERASES `import type` / `export type`, so `packages/core/src/x.ts` could name
 * `@ultimat3/cli` — tier 0 reaching tier 5 — and this script reported clean, while the contract
 * says a tier violation is a build error. Dropping the keyword before the parse makes the
 * transpiler report it as an ordinary import.
 *
 * Done as a rewrite fed BACK THROUGH the transpiler rather than as a regex over raw text, because
 * the raw text is full of decoys: `packages/cli/src/templates/*.ts` emit generated app source
 * inside template literals, and doc blocks quote import lines verbatim. The transpiler still sees
 * those as a string and a comment; a regex would report them as this file's own imports.
 */
const TYPE_ONLY_CLAUSE = /\b(import|export)\s+type\s+(?=[{*]|[A-Za-z_$][\w$]*\s+from\b)/g;

export const dropTypeKeyword = (source: string): string =>
  // The lookahead is what keeps `export type Foo = string` — a type ALIAS, not an import — from
  // becoming `export Foo = string`, which is a syntax error the transpiler then reports instead
  // of the imports this pass exists to find.
  source.replace(TYPE_ONLY_CLAUSE, '$1 ');

/** Bun's transpiler is the parser: type-only imports are erased, dynamic imports are included. */
export function importsOf(file: SourceFile): readonly string[] {
  const loader = file.path.endsWith('x') ? 'tsx' : 'ts';
  return new Bun.Transpiler({ loader })
    .scanImports(stripShebang(file.source))
    .map((entry) => entry.path);
}

/**
 * Every specifier the file names, type-only ones included. The tier rule applies to both — a
 * type-only edge still couples two packages' release cycles. `checkSharedLeaf` deliberately does
 * NOT use this: naming an `app/` type from a leaf is legal there, loading its module is not.
 */
export function allImportsOf(file: SourceFile): readonly string[] {
  const loader = file.path.endsWith('x') ? 'tsx' : 'ts';
  const typed = new Bun.Transpiler({ loader })
    .scanImports(dropTypeKeyword(stripShebang(file.source)))
    .map((entry) => entry.path);
  return [...new Set([...importsOf(file), ...typed])];
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
 * `src/` is not all of a package's source: three packages carry an `e2e` directory beside it,
 * and every rule here was blind to them — `packages/core/e2e/version.e2e.test.ts` could import
 * `@ultimat3/cli` (tier 0 reaching tier 5) and this script reported "no boundary violations".
 */
const SOURCE_PATTERNS = ['packages/*/src/**/*.{ts,tsx}', 'packages/*/e2e/**/*.{ts,tsx}'] as const;

export async function collectSourceFiles(root: string): Promise<readonly SourceFile[]> {
  const seen = new Set<string>();
  const files: SourceFile[] = [];
  for (const pattern of SOURCE_PATTERNS) {
    for (const file of await readFiles(root, pattern)) {
      if (seen.has(file.path)) continue;
      seen.add(file.path);
      files.push(file);
    }
  }
  return files;
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
  // `{examples,dummy}`: the demo app under `dummy/` is the one CI publishes an image for on every
  // push to main, and the header's reason for checking the rule here — that the app gate runs
  // advisory-only — applies to it verbatim. Its 8 `shared/` modules were checked by nothing.
  const files = await readFiles(root, '{examples,dummy}/*/apps/*/shared/**/*.{ts,tsx}');
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

export async function collectAdminFiles(root: string): Promise<readonly SourceFile[]> {
  return readFiles(root, 'packages/admin/src/**/*.ts');
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const only = args.flags.get('package');
  const files = (await collectSourceFiles(root)).filter(
    (file) => typeof only !== 'string' || packageOf(file.path) === only,
  );
  const violations = checkBoundaries(files);
  // `--package` narrows to one framework package; the leaf and flattener rules are each about one
  // fixed location (an app's `shared/`, `@ultimat3/admin`), not "whichever package was asked for".
  const sharedFiles = typeof only === 'string' ? [] : await collectSharedFiles(root);
  const leaks = checkSharedLeaf(sharedFiles);
  const adminFiles = typeof only === 'string' ? [] : await collectAdminFiles(root);
  const adminLeaks = checkAdminFlattener(adminFiles);
  const findings = [
    ...violations.map(findingFor),
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
      data: { files: scanned, violations, leaks, adminLeaks },
    },
    args.json,
  );
}
