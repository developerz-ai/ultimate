#!/usr/bin/env bun
// Enforce that every external workspace dependency is an explicit row in the checked-in allowlist.
//
// Root `CLAUDE.md` allows no new dependency without a stated reason. A name-only allowlist would
// duplicate the workspace registry, so internal names are checked against the real workspaces and
// external names against the checked-in table.
//
//   bun run dependency-allowlist  ·  bun run scripts/dependency-allowlist.ts [--json]

import { parseScriptArgs } from './lib/args';
import { DEPENDENCY_ALLOWLIST, DEPENDENCY_ALLOWLIST_FILE } from './lib/dependency-allowlist-data';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { toPosix } from './lib/posix-path';
import { repoRoot } from './lib/run';
import { readWorkspaceManifest } from './lib/workspaces';

const SCRIPT = 'dependency-allowlist';

export interface DependencyDeclaration {
  readonly manifest: string;
  readonly field: 'dependencies' | 'devDependencies';
  readonly name: string;
}

export interface DependencyAllowlistInput {
  readonly declarations: readonly DependencyDeclaration[];
  readonly workspaceNames: ReadonlySet<string>;
  readonly allowlist: Readonly<Record<string, { readonly reason: string }>>;
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
  for (const manifest of ['package.json', ...(await dependencyManifestPaths(root))]) {
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
      for (const name of Object.keys(read.manifest[field] ?? {})) {
        declarations.push({ manifest, field, name });
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
  });
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
