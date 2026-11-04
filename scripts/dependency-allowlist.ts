#!/usr/bin/env bun
// Enforce that every external workspace dependency is an explicit row in the checked-in allowlist,
// and that a dependency declared in two manifests is DECLARED COMPATIBLY in both.
//
// Root `CLAUDE.md` allows no new dependency without a stated reason. A name-only allowlist would
// duplicate the workspace registry, so internal names are checked against the real workspaces and
// external names against the checked-in table. The root manifest is the tree's reference range:
// a workspace that declares the same dependency must accept a version the root accepts, or the
// tree installs two different versions of one package.
//
//   bun run dependency-allowlist  ·  bun run scripts/dependency-allowlist.ts [--json]

import { parseScriptArgs } from './lib/args';
import { DEPENDENCY_ALLOWLIST, DEPENDENCY_ALLOWLIST_FILE } from './lib/dependency-allowlist-data';
import { rangeCompatibility } from './lib/dependency-ranges';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { toPosix } from './lib/posix-path';
import { repoRoot } from './lib/run';
import { readWorkspaceManifest } from './lib/workspaces';

const SCRIPT = 'dependency-allowlist';

/** The root manifest, relative to the repository root. The reference range of every dependency. */
export const ROOT_MANIFEST = 'package.json';

export interface DependencyDeclaration {
  readonly manifest: string;
  readonly field: 'dependencies' | 'devDependencies';
  readonly name: string;
  /** The version range this manifest declares, as written. Never compared as text. */
  readonly range: string;
}

export interface DependencyAllowlistInput {
  readonly declarations: readonly DependencyDeclaration[];
  readonly workspaceNames: ReadonlySet<string>;
  readonly allowlist: Readonly<Record<string, { readonly reason: string }>>;
  /**
   * The ROOT manifest's declarations, by dependency name. The root is the tree's reference range:
   * a workspace declaring the same dependency must accept a version the root accepts.
   */
  readonly rootDeclarations?: ReadonlyMap<string, DependencyDeclaration>;
}

const keyOf = (declaration: DependencyDeclaration): string =>
  `${declaration.manifest}#${declaration.field}#${declaration.name}`;

const overFinding = (declaration: DependencyDeclaration): Finding => ({
  code: 'X_DEPENDENCY_NOT_ALLOWLISTED',
  cause: `${declaration.manifest} declares ${declaration.name} in ${declaration.field} and no checked-in allowlist row accepts it — a new dependency needs a stated reason`,
  fix: `bun run scripts/dependency-allowlist.ts --json   # then add '${keyOf(declaration)}' with a reason to ${DEPENDENCY_ALLOWLIST_FILE}`,
  at: declaration.manifest,
});

const staleFinding = (key: string): Finding => ({
  code: 'X_DEPENDENCY_ALLOWLIST_STALE',
  cause: `${DEPENDENCY_ALLOWLIST_FILE} allows '${key}', but no workspace manifest declares it — a stale row would hide a later declaration of the same name`,
  fix: `bun run scripts/dependency-allowlist.ts --json   # then delete '${key}' from ${DEPENDENCY_ALLOWLIST_FILE}`,
  at: DEPENDENCY_ALLOWLIST_FILE,
});

/**
 * The range conflict: one dependency, two manifests, and no version both accept.
 *
 * The cause names the dependency, the ROOT manifest with its range and the conflicting manifest
 * with its range — one line, so a reader sees which two declarations to reconcile without
 * opening a second file.
 */
const conflictFinding = (
  name: string,
  root: DependencyDeclaration,
  other: DependencyDeclaration,
  problem: string,
): Finding => ({
  code: 'X_DEPENDENCY_RANGE_CONFLICT',
  cause: `${name} is declared as '${root.range}' in ${root.manifest} and as '${other.range}' in ${other.manifest}, and ${problem}`,
  fix: `bun run scripts/dependency-allowlist.ts --json   # then widen one of the two ranges so a single version satisfies both`,
  at: other.manifest,
});

/** One manifest path per workspace, including the root and both tracked applications. */
export async function dependencyManifestPaths(root: string): Promise<readonly string[]> {
  const paths = new Set<string>();
  const patterns = [
    'packages/*/package.json',
    'examples/*/package.json',
    'dummy/*/package.json',
    'examples/*/apps/*/package.json',
    'examples/*/packages/*/package.json',
    'dummy/*/apps/*/package.json',
    'dummy/*/packages/*/package.json',
  ];
  for (const pattern of patterns) {
    for await (const found of new Bun.Glob(pattern).scan({ cwd: root, absolute: false })) {
      paths.add(toPosix(found));
    }
  }
  return [...paths].sort();
}

/**
 * What one pass over the workspace manifests found — and the manifest that could not be read.
 *
 * `unreadable` is the answer a skipped manifest must never be: a manifest that does not parse is
 * not a manifest with no dependencies, it is a dependency this rule never saw. `scripts/lib/corpus.ts`
 * states the same rule for a whole tree — "a guard whose glob matched nothing answered 'no findings',
 * which is exactly what a clean tree answers".
 */
export interface WorkspaceScan {
  readonly declarations: readonly DependencyDeclaration[];
  readonly names: ReadonlySet<string>;
  /** The first manifest that could not be read, and why. Absent means every manifest was read. */
  readonly unreadable?: { readonly manifest: string; readonly problem: string };
}

/** One pass over every workspace manifest: the declarations, the names, and what could not be read. */
export async function scanWorkspaceManifests(root: string): Promise<WorkspaceScan> {
  const declarations: DependencyDeclaration[] = [];
  const names = new Set<string>();
  for (const manifest of [ROOT_MANIFEST, ...(await dependencyManifestPaths(root))]) {
    const read = await readWorkspaceManifest(`${root}/${manifest}`);
    if (read.kind !== 'read') {
      return {
        declarations,
        names,
        unreadable: {
          manifest,
          problem: read.kind === 'absent' ? 'vanished between the glob and the read' : read.problem,
        },
      };
    }
    if (typeof read.manifest.name === 'string') names.add(read.manifest.name);
    for (const field of ['dependencies', 'devDependencies'] as const) {
      for (const [name, range] of Object.entries(read.manifest[field] ?? {})) {
        declarations.push({ manifest, field, name, range });
      }
    }
  }
  return { declarations, names };
}

/** Every dependency and devDependency every workspace manifest declares. */
export async function dependencyDeclarations(
  root: string,
): Promise<readonly DependencyDeclaration[]> {
  return (await scanWorkspaceManifests(root)).declarations;
}

/** The names every workspace in this tree publishes, read off the manifests themselves. */
export async function workspaceNames(root: string): Promise<ReadonlySet<string>> {
  return (await scanWorkspaceManifests(root)).names;
}

/**
 * The cross-manifest check: a dependency declared in more than one manifest must be declared
 * COMPATIBLY in every one of them.
 *
 * The ROOT manifest is the reference. Two ranges conflict when no single version satisfies both —
 * never when their texts differ: the root's `^7.0.2` and an app's `7.0.2` agree, and a textual
 * comparison would report every one of this tree's own pairs.
 *
 * A name the root does not declare has no reference range, and the rule says nothing about it —
 * the root's absence is not a conflict.
 */
export function checkDependencyRanges(
  declarations: readonly DependencyDeclaration[],
  rootDeclarations: ReadonlyMap<string, DependencyDeclaration>,
): readonly Finding[] {
  const findings: Finding[] = [];
  for (const declaration of declarations) {
    if (declaration.manifest === ROOT_MANIFEST) continue;
    const root = rootDeclarations.get(declaration.name);
    if (root === undefined) continue;
    const answer = rangeCompatibility(root.range, declaration.range);
    if (answer.kind === 'compatible') continue;
    const problem =
      answer.kind === 'incompatible'
        ? 'no single version satisfies both ranges'
        : `the range '${answer.range}' ${answer.problem}`;
    findings.push(conflictFinding(declaration.name, root, declaration, problem));
  }
  return findings;
}

export function checkDependencyAllowlist(input: DependencyAllowlistInput): readonly Finding[] {
  const findings: Finding[] = [];
  const declared = new Set<string>();
  for (const declaration of input.declarations) {
    const key = keyOf(declaration);
    declared.add(key);
    if (input.workspaceNames.has(declaration.name)) continue;
    if (!Object.hasOwn(input.allowlist, key)) findings.push(overFinding(declaration));
  }
  for (const key of Object.keys(input.allowlist)) {
    if (!declared.has(key)) findings.push(staleFinding(key));
  }
  if (input.rootDeclarations !== undefined) {
    findings.push(...checkDependencyRanges(input.declarations, input.rootDeclarations));
  }
  return findings;
}

/** Every finding this rule contributes, read off the real manifests and the checked-in table. */
export async function dependencyAllowlistFindings(root: string): Promise<readonly Finding[]> {
  const rootManifest = await readWorkspaceManifest(`${root}/package.json`);
  if (rootManifest.kind !== 'read') {
    return [
      {
        code: 'X_DEPENDENCY_UNSCANNED',
        cause:
          'the root package.json could not be read, so no workspace manifest was checked and every dependency reports zero',
        fix: 'bun run scripts/dependency-allowlist.ts --json   # from the repository root',
        at: 'package.json',
      },
    ];
  }
  const scan = await scanWorkspaceManifests(root);
  // A workspace manifest that could not be read is refused, not skipped: skipping it reports a
  // clean tree over a dependency this rule never saw.
  if (scan.unreadable !== undefined) {
    return [
      {
        code: 'X_DEPENDENCY_UNSCANNED',
        cause: `${scan.unreadable.manifest} ${scan.unreadable.problem}, so the dependencies it declares were never checked`,
        fix: 'bun run scripts/dependency-allowlist.ts --json   # from the repository root',
        at: scan.unreadable.manifest,
      },
    ];
  }
  const { declarations, names } = scan;
  if (declarations.length === 0 || names.size === 0) {
    return [
      {
        code: 'X_DEPENDENCY_UNSCANNED',
        cause:
          'no workspace manifest declared a dependency, so the allowlist enforced nothing — a glob that matches nothing reads exactly like a tree with no dependencies',
        fix: 'bun run scripts/dependency-allowlist.ts --json   # from the repository root',
        at: 'package.json',
      },
    ];
  }
  return checkDependencyAllowlist({
    declarations,
    workspaceNames: names,
    allowlist: DEPENDENCY_ALLOWLIST,
    rootDeclarations: rootDeclarationsOf(declarations),
  });
}

/**
 * The ROOT manifest's declarations, by dependency name.
 *
 * The root is scanned FIRST, so its declarations come first in the scan; the map keeps the first
 * of each name, which is the root's own. A name the root does not declare has no entry, and the
 * cross-manifest rule then says nothing about it.
 */
export function rootDeclarationsOf(
  declarations: readonly DependencyDeclaration[],
): ReadonlyMap<string, DependencyDeclaration> {
  const byName = new Map<string, DependencyDeclaration>();
  for (const declaration of declarations) {
    if (declaration.manifest !== ROOT_MANIFEST) continue;
    if (!byName.has(declaration.name)) byName.set(declaration.name, declaration);
  }
  return byName;
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const findings = await dependencyAllowlistFindings(repoRoot());
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      summary:
        findings.length === 0
          ? 'every external workspace dependency is an explicit allowlist row'
          : `${String(findings.length)} dependency allowlist finding(s)`,
      findings,
    },
    args.json,
  );
}
