// The workspace dependency graph, in the two forms that must agree: the edges every manifest
// DECLARES, the edges every shipped source file actually IMPORTS, and the gate rule that the
// second is a subset of the first. An edge that lives only in a tsconfig `paths` entry resolves
// for `tsc` and is invisible to bun, to `--filter` ordering and to any change-detection tool.

import { join } from 'node:path';
import type { Finding } from './output';
import { eachSourceFile, isGenerated, isTest, isVendored } from './source-files';
import { maskLiterals } from './ts-scan';

export interface WorkspaceNode {
  /** package.json "name". */
  readonly name: string;
  /** Directory, root-relative and POSIX. */
  readonly dir: string;
  /** Workspace package names this one declares, across every dependency field. */
  readonly dependencies: readonly string[];
  /**
   * package.json "version", `0.0.0` when the manifest states none. Optional on the type and always
   * present in what `readWorkspaceGraph` returns — the range a `fix:` tells an author to pin to has
   * to be the one the workspace really carries, or the edit it names fails `checkLockstep` next.
   */
  readonly version?: string;
}

/**
 * Every field npm installs from. `devDependencies` counts as a declaration here — it resolves the
 * import exactly like `dependencies` does; only the tarball tells them apart, which is
 * `checkPublishShape`'s question and not this one.
 */
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const stringsOf = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

/**
 * A manifest that will not parse, or will not open, is SKIPPED rather than thrown from. Both this
 * rule and change detection read the whole graph in one pass, so one unparseable package.json
 * anywhere in a monorepo would take the caller down with a `SyntaxError` naming no file — which is
 * issue #281, open against `scripts/lib/workspaces.ts`, and not a defect worth having twice.
 */
async function readManifest(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return asRecord(await Bun.file(path).json());
  } catch {
    return undefined;
  }
}

/** The `workspaces` globs a root manifest declares, in both spellings npm accepts. */
export function workspaceGlobs(manifest: unknown): readonly string[] {
  const field = asRecord(manifest)?.['workspaces'];
  return Array.isArray(field) ? stringsOf(field) : stringsOf(asRecord(field)?.['packages']);
}

const declaredDepsOf = (manifest: Record<string, unknown>): readonly string[] =>
  DEPENDENCY_FIELDS.flatMap((field) => Object.keys(asRecord(manifest[field]) ?? {}));

export interface WorkspaceScan {
  readonly nodes: readonly WorkspaceNode[];
  /**
   * Manifest paths the root's globs claim that do not parse, or name no package. Skipping one is
   * what keeps a caller alive; reporting it is what keeps the skip from being a hiding place — a
   * workspace absent from the graph is a workspace no rule here can see.
   */
  readonly unreadable: readonly string[];
}

/**
 * Every workspace the root manifest claims, sorted by directory. Two workspaces answering to one
 * name keep the first by that order rather than the first the glob happened to yield — a graph a
 * second run disagrees with is worse than either answer.
 */
export async function scanWorkspaces(root: string): Promise<WorkspaceScan> {
  const rootManifest = await readManifest(join(root, 'package.json'));
  const found: { dir: string; name: string; version: string; declared: readonly string[] }[] = [];
  const unreadable: string[] = [];
  for (const pattern of workspaceGlobs(rootManifest)) {
    for await (const relative of new Bun.Glob(`${pattern}/package.json`).scan({
      cwd: root,
      absolute: false,
    })) {
      if (isVendored(relative)) continue;
      const manifest = await readManifest(join(root, relative));
      const name = manifest?.['name'];
      if (manifest === undefined || typeof name !== 'string' || name === '') {
        unreadable.push(relative.replaceAll('\\', '/'));
        continue;
      }
      const version = manifest['version'];
      found.push({
        dir: relative.replaceAll('\\', '/').slice(0, -'/package.json'.length),
        name,
        version: typeof version === 'string' ? version : '0.0.0',
        declared: declaredDepsOf(manifest),
      });
    }
  }
  found.sort((left, right) => left.dir.localeCompare(right.dir));
  const names = new Set<string>();
  const unique = found.filter((entry) => {
    if (names.has(entry.name)) return false;
    names.add(entry.name);
    return true;
  });
  // Second pass, once every name is known: an edge is only an edge to another WORKSPACE. A
  // dependency on a registry package is a fact about the lockfile, not about this repo's shape.
  const nodes = unique.map(({ dir, name, version, declared }) => ({
    dir,
    name,
    version,
    dependencies: [...new Set(declared)].filter((dep) => dep !== name && names.has(dep)),
  }));
  return { nodes, unreadable: unreadable.sort() };
}

/** The graph alone, for every caller that has nothing to report about the manifests it skipped. */
export const readWorkspaceGraph = async (root: string): Promise<readonly WorkspaceNode[]> =>
  (await scanWorkspaces(root)).nodes;

/**
 * The package a bare specifier names — `@scope/pkg/sub` → `@scope/pkg`, `pkg/sub` → `pkg`. A
 * relative, absolute or protocol specifier (`node:fs`, `bun:test`) names no package at all.
 */
export function packageOfSpecifier(specifier: string): string | undefined {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.includes(':')) {
    return undefined;
  }
  const [first, second] = specifier.split('/');
  if (first === undefined || first === '') return undefined;
  if (!first.startsWith('@')) return first;
  return second === undefined || second === '' ? undefined : `${first}/${second}`;
}

/**
 * Every form that names a module: `… from '…'`, a bare `import '…'`, `import('…')`, `require('…')`.
 * `from` is matched only where a quote follows it directly, so `from<Row>('posts', …)` — the query
 * builder, which reads exactly like an import — cannot be one.
 */
const IMPORT_FORM =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|(?:^|[;{])\s*import\s+)['"]([^'"]*)['"]/g;

/**
 * Every package a source file imports, deduplicated, in first-appearance order.
 *
 * Read from the MASKED text, because a generator's template literal holds whole programs: every
 * `templates/*.ts` here emits `import … from '@ultimat3/ui'` as a string, and a scan that read
 * those would bill the CLI for the imports of the app it writes. The line a masked hit falls on is
 * then re-read from the real source — the specifier itself is what masking blanks.
 */
export function importedPackages(source: string): readonly string[] {
  const masked = maskLiterals(source).split('\n');
  const lines = source.split('\n');
  const packages = new Set<string>();
  for (const [index, maskedLine] of masked.entries()) {
    const line = lines[index];
    // `matchAll` clones the regex, so the shared `lastIndex` is never carried between lines.
    if (line === undefined || [...maskedLine.matchAll(IMPORT_FORM)].length === 0) continue;
    for (const match of line.matchAll(IMPORT_FORM)) {
      const name = packageOfSpecifier(match[1] ?? '');
      if (name !== undefined) packages.add(name);
    }
  }
  return [...packages];
}

/**
 * Borrowed, not twinned: `X_APP_PACKAGE_INVALID` already means "this package.json supplies no
 * usable name", and a workspace manifest is that same file one directory down. `bun pm pkg set`
 * is not the fix here — it parses the file it edits, so it fails on exactly the input this
 * reports.
 */
export const unreadableWorkspaceFinding = (path: string): Finding => ({
  code: 'X_APP_PACKAGE_INVALID',
  cause: `${path} is claimed by the root "workspaces" globs and supplies no readable "name"`,
  fix: `repair the JSON and the "name" in ${path}, or drop its directory from "workspaces" in package.json`,
  docs: 'https://ultimate.dev/errors/X_APP_PACKAGE_INVALID',
  at: path,
});

export const undeclaredWorkspaceDepFinding = (
  from: WorkspaceNode,
  to: WorkspaceNode,
  at: string,
): Finding => ({
  code: 'X_WORKSPACE_DEP_UNDECLARED',
  cause: `${at} imports ${to.name}, which ${from.dir}/package.json does not declare`,
  // The exact line to paste, at the version the target really carries: a `workspace:*` range would
  // resolve and then fail `checkLockstep`, which compares a sibling pin against the version.
  fix: `add "${to.name}": "${to.version ?? '0.0.0'}" to "dependencies" in ${from.dir}/package.json`,
  docs: 'https://ultimate.dev/errors/X_WORKSPACE_DEP_UNDECLARED',
  at: `${from.dir}/package.json`,
});

/**
 * The declared graph must cover the real one. `x new` wrote packages that import each other and
 * declared none of it — the imports resolved through the root tsconfig's `paths`, so the edges
 * existed only inside `tsc` and every tool that asks what a change affects answered short.
 *
 * Shipped source only. A test file is excluded from the tarball by every package here
 * (`TEST_EXCLUSION`) and resolves its imports through the ROOT manifest's hoisted devDependencies,
 * which is why no `packages/*` in this repo carries a `devDependencies` block of its own —
 * judging test imports would demand 29 of them to describe a resolution that already works.
 *
 * One finding per (workspace, dependency) pair, never one per import site: the fix is one line in
 * one manifest, and repeating it per file is noise an author has to deduplicate by hand.
 */
export async function checkWorkspaceDependencies(root: string): Promise<readonly Finding[]> {
  const { nodes: graph, unreadable } = await scanWorkspaces(root);
  const findings: Finding[] = unreadable.map(unreadableWorkspaceFinding);
  if (graph.length === 0) return findings;
  const byName = new Map(graph.map((node) => [node.name, node]));
  // Deepest directory first: a nested workspace's files are its own, never its parent's.
  const owners = [...graph].sort((left, right) => right.dir.length - left.dir.length);
  const reported = new Set<string>();
  for await (const path of eachSourceFile(root)) {
    if (isTest(path) || isGenerated(path)) continue;
    const owner = owners.find((node) => path.startsWith(`${node.dir}/`));
    if (owner === undefined) continue;
    for (const name of importedPackages(await Bun.file(join(root, path)).text())) {
      const target = byName.get(name);
      if (target === undefined || target.name === owner.name) continue;
      if (owner.dependencies.includes(target.name)) continue;
      const pair = `${owner.dir} ${target.name}`;
      if (reported.has(pair)) continue;
      reported.add(pair);
      findings.push(undeclaredWorkspaceDepFinding(owner, target, path));
    }
  }
  return findings;
}
