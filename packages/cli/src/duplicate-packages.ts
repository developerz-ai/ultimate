// Two installed copies of one registry-holding framework package, found before either registry is
// asked anything. `@ultimat3/i18n`, `@ultimat3/policy` and `@ultimat3/entity` each keep their
// registry at MODULE scope, so a second module instance is a second, EMPTY registry: an app whose
// `packages/i18n` workspace pinned `@ultimat3/i18n@19.0.0` while its root had 19.1.0 registered
// every catalog into the workspace's copy, the CLI read the root's, and `x i18n check` answered
// `X_CATALOG_UNREGISTERED` with a fix that said to move a `defineCatalogs()` call that was already
// exactly where the fix said to put it (ai-maxxing, 2026-09-05). The same split is the one
// `local-cli.ts` hands over for — a global `x` is a second copy of `@ultimat3/entity` — except this
// one lives inside the app's own `node_modules`, where no hand-over can reach it.

// why: Bun ships no symlink-resolving stat and no path API of its own. `realpathSync` is the whole
// decision — two symlinks to one directory are one module instance, and two store entries at one
// version are still two — and `dirname`/`join` walk a resolved entry up to the package that owns it.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
// why: Bun exposes no path API — `dirname` walks a resolved entry up to the package that owns it,
// `join` reaches its manifest, and `relative` is what turns an absolute hit into the repo-relative
// path a finding names.
import { dirname, join, relative } from 'node:path';
import { ERROR_DOCS_URL } from '@ultimat3/core';
import type { Finding } from './output';
import { readWorkspaceGraph } from './workspace-graph';

/**
 * The packages whose registry is a module-scope table, and what that table is called in a finding.
 * A second copy of any other `@ultimat3/*` package is a mixed-version install the CHANGELOG already
 * warns against; a second copy of one of these is an app that registers into a registry nothing
 * reads.
 */
export const REGISTRY_PACKAGES: Readonly<Record<string, string>> = {
  '@ultimat3/i18n': 'catalog registry',
  '@ultimat3/policy': 'permission registry',
  '@ultimat3/entity': 'entity registry',
};

/** One resolution of one package from one directory. `dir` is the package's REAL directory. */
export interface InstalledCopy {
  readonly pkg: string;
  /** Where the resolution started, app-root-relative: `.`, a workspace dir, or `CLI_ORIGIN`. */
  readonly from: string;
  readonly dir: string;
  readonly version: string;
}

/** The `from` label of the copy the running CLI itself imports. */
export const CLI_ORIGIN = 'the x CLI';

/** One distinct copy of a duplicated package, and every origin that resolves to it. */
export interface DuplicateCopy {
  readonly dir: string;
  readonly version: string;
  readonly from: readonly string[];
}

export interface DuplicateInstall {
  readonly pkg: string;
  /** Newest version first; ties in `dir` order, so a report is stable across runs. */
  readonly copies: readonly DuplicateCopy[];
}

/**
 * Semver order, through Bun's own comparator so `19.1.0-beta.1` sorts BELOW `19.1.0` and
 * `19.10.0` above `19.9.0`; a string that is not a version falls back to its text, because the
 * report still has to be stable over whatever a hand-edited manifest carries.
 */
function compareVersions(left: string, right: string): number {
  try {
    return Bun.semver.order(left, right);
  } catch {
    return left.localeCompare(right);
  }
}

/**
 * The pure half: every package that resolves to more than one real directory. Keyed by REALPATH,
 * never by version — two workspace symlinks to one checkout are one instance whatever the labels
 * say, and two store entries both stamped `19.1.0` are two instances all the same, because a
 * module registry is per module instance and not per version string.
 */
export function duplicateInstalls(copies: readonly InstalledCopy[]): readonly DuplicateInstall[] {
  const byPackage = new Map<string, Map<string, { version: string; from: string[] }>>();
  for (const copy of copies) {
    const dirs = byPackage.get(copy.pkg) ?? new Map<string, { version: string; from: string[] }>();
    const entry = dirs.get(copy.dir) ?? { version: copy.version, from: [] };
    if (!entry.from.includes(copy.from)) entry.from.push(copy.from);
    dirs.set(copy.dir, entry);
    byPackage.set(copy.pkg, dirs);
  }
  const duplicates: DuplicateInstall[] = [];
  for (const [pkg, dirs] of byPackage) {
    if (dirs.size < 2) continue;
    const sorted = [...dirs.entries()]
      .map(([dir, entry]) => ({ dir, version: entry.version, from: [...entry.from].sort() }))
      .sort(
        (left, right) =>
          compareVersions(right.version, left.version) || left.dir.localeCompare(right.dir),
      );
    duplicates.push({ pkg, copies: sorted });
  }
  return duplicates.sort((left, right) => left.pkg.localeCompare(right.pkg));
}

/** The filesystem this reader touches, injectable so a fixture needs no install. */
export interface DuplicateIo {
  /** The resolved entry file, or throws — `Bun.resolveSync`'s contract. */
  resolve(specifier: string, from: string): string;
  realpath(path: string): string;
  exists(path: string): boolean;
  readText(path: string): string;
}

const nodeIo: DuplicateIo = {
  resolve: (specifier, from) => Bun.resolveSync(specifier, from),
  realpath: (path) => realpathSync(path),
  exists: (path) => existsSync(path),
  readText: (path) => readFileSync(path, 'utf8'),
};

/**
 * Deep enough for `src/index.ts` and for any entry an `exports` map could point at, shallow enough
 * that a resolver answering something unexpected stops rather than walking to `/` — the same bound
 * `framework-scope.ts` walks under.
 */
const MAX_DEPTH = 6;

/**
 * The real directory owning `entry`, judged by the `package.json` that NAMES `pkg`. The entry alone
 * is not enough: a workspace checkout resolves to `packages/i18n/src/index.ts` and a published
 * install to `…/dist/index.js`, and the first `package.json` upward from either is the one that
 * says which package it is — a stray manifest in a `src/` would otherwise be reported as a copy.
 */
function packageDirOf(
  pkg: string,
  entry: string,
  io: DuplicateIo,
): { dir: string; version: string } | undefined {
  let dir = dirname(entry);
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const manifest = join(dir, 'package.json');
    if (io.exists(manifest)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(io.readText(manifest));
      } catch {
        return undefined;
      }
      if (typeof parsed !== 'object' || parsed === null) return undefined;
      const fields = parsed as Record<string, unknown>;
      if (fields['name'] !== pkg) return undefined;
      const version = fields['version'];
      return { dir: io.realpath(dir), version: typeof version === 'string' ? version : '0.0.0' };
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/**
 * One resolution per (package, origin), for every origin that IMPORTS the package in a real boot:
 * the app root, every workspace the root manifest claims, and this CLI's own directory — which is
 * what `x i18n check` reads its registry through. A directory that cannot resolve the package
 * contributes nothing: a workspace with no dependency on `@ultimat3/policy` is not a copy of it.
 *
 * `cliDir` is injectable so a test can stand the CLI somewhere with no framework under it;
 * production passes nothing, and the only defensible base is this module's own directory.
 */
export async function installedCopies(
  root: string,
  packages: readonly string[],
  io: DuplicateIo = nodeIo,
  cliDir: string = import.meta.dir,
): Promise<readonly InstalledCopy[]> {
  const origins: { from: string; dir: string }[] = [{ from: '.', dir: root }];
  for (const node of await readWorkspaceGraph(root)) {
    origins.push({ from: node.dir, dir: join(root, node.dir) });
  }
  origins.push({ from: CLI_ORIGIN, dir: cliDir });

  const copies: InstalledCopy[] = [];
  for (const pkg of packages) {
    for (const origin of origins) {
      let entry: string;
      try {
        entry = io.resolve(pkg, origin.dir);
      } catch {
        continue;
      }
      const owner = packageDirOf(pkg, entry, io);
      if (owner === undefined) continue;
      copies.push({ pkg, from: origin.from, dir: owner.dir, version: owner.version });
    }
  }
  return copies;
}

/** The two steps composed — what `x i18n check` and the gate's `policy` step call. */
export async function findDuplicateInstalls(
  root: string,
  packages: readonly string[],
): Promise<readonly DuplicateInstall[]> {
  return duplicateInstalls(await installedCopies(root, packages));
}

/** What a caller injects in place of `findDuplicateInstalls`, so a fixture needs no install. */
export type DuplicateProbe = (
  root: string,
  packages: readonly string[],
) => Promise<readonly DuplicateInstall[]>;

/** `<dir>@<version> (resolved from ., packages/i18n)` — one clause per copy. */
const renderCopy = (root: string, copy: DuplicateCopy): string => {
  const shown = relative(root, copy.dir).replaceAll('\\', '/');
  const dir = shown === '' || shown.startsWith('..') ? copy.dir : shown;
  return `${dir}@${copy.version} (resolved from ${copy.from.join(', ')})`;
};

/** The manifest an origin pins its dependencies in — the file the fix names an edit to. */
const manifestOf = (from: string): string | undefined =>
  from === CLI_ORIGIN ? undefined : from === '.' ? 'package.json' : `${from}/package.json`;

/**
 * The one sentence both findings share: which copies, where each is read from, and why that is
 * an empty registry rather than a version skew. `root` is what turns a store path into the
 * app-relative one an agent can open.
 */
export function duplicateCause(root: string, duplicate: DuplicateInstall): string {
  const registry = REGISTRY_PACKAGES[duplicate.pkg] ?? 'registry';
  const copies = duplicate.copies.map((copy) => renderCopy(root, copy)).join(' and ');
  return (
    `${duplicate.copies.length} copies of ${duplicate.pkg} are installed: ${copies} — each is ` +
    `its own module instance with its own ${registry}, so what the app registers into one, the ` +
    'other never sees'
  );
}

/**
 * The command that leaves ONE copy, then the command that re-checks. Two shapes, because the two
 * causes repair differently: copies at different versions are a workspace pinning an older
 * range, and the fix names that manifest and the version to pin; copies at ONE version are two
 * resolutions of one range — a stale nested `node_modules`, or two peer sets in the store — and
 * the only edit that can collapse them is the install itself.
 */
export function duplicateFix(duplicate: DuplicateInstall, recheck: string): string {
  const newest = duplicate.copies[0];
  const older = duplicate.copies.filter((copy) => copy.version !== newest?.version);
  if (newest !== undefined && older.length > 0) {
    const manifests = [
      ...new Set(older.flatMap((copy) => copy.from.map(manifestOf)).filter(Boolean)),
    ];
    const where = manifests.length === 0 ? 'every package.json that pins it' : manifests.join(', ');
    return `set "${duplicate.pkg}": "${newest.version}" in ${where}, then: bun install && ${recheck}`;
  }
  return `bun install --force   # one resolution of ${duplicate.pkg} for every workspace; then: ${recheck}`;
}

/**
 * The finding both steps report. Its own code rather than the registry's own (`X_CATALOG_UNREGISTERED`,
 * `X_PERMISSION_UNKNOWN`): those name a symptom that has a source-level repair, and this names an
 * install with no source-level repair at all — an agent handed the registry's fix edits a file that
 * is already right, re-runs, and is red again.
 */
export function duplicateFinding(
  root: string,
  duplicate: DuplicateInstall,
  recheck: string,
): Finding {
  const at = duplicate.copies
    .flatMap((copy) => copy.from.map(manifestOf))
    .find((manifest): manifest is string => manifest !== undefined);
  return {
    code: 'X_PACKAGE_DUPLICATED',
    cause: duplicateCause(root, duplicate),
    fix: duplicateFix(duplicate, recheck),
    docs: ERROR_DOCS_URL,
    ...(at === undefined ? {} : { at }),
  };
}
