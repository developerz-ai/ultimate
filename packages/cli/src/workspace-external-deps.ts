// Every registry package a workspace's shipped source imports is declared in THAT workspace's own
// manifest. Bun hoists one copy to the root `node_modules`, so an import a sibling happens to declare
// resolves for `tsc`, `boundaries` and the tests alike — until a clean or filtered install stops
// hoisting it and CI breaks on a tree every step called green (`bitecs`, an adopter, v31).

// why: Bun has no native "is this specifier a runtime builtin" predicate; `bun` and `bun:*` included.
import { isBuiltin } from 'node:module';
import { join } from 'node:path'; // why: Bun exposes no path-join primitive.
import { ERROR_DOCS_URL, renderFixShellArg } from '@ultimat3/core';
import type { Finding } from './output';
import { FIXTURE_SUFFIX } from './publish-closure';
import { eachSourceFile, isGenerated, isTest } from './source-files';
import { importedPackages, packageOfSpecifier, scanWorkspaces } from './workspace-graph';

/** Every field a package manager installs from — the same four `workspace-graph` reads. */
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

const asRecord = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** JSONC: a tsconfig may carry comments; absent and unreadable both mean "declares nothing". */
async function readObject(path: string): Promise<Readonly<Record<string, unknown>> | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  try {
    return asRecord(Bun.JSONC.parse(await file.text()));
  } catch {
    return undefined;
  }
}

/** name → range, across every installing field; the first field to declare a name wins. */
const declaredOf = (
  manifest: Readonly<Record<string, unknown>> | undefined,
): Map<string, string> => {
  const declared = new Map<string, string>();
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, range] of Object.entries(asRecord(manifest?.[field]) ?? {})) {
      if (!declared.has(name)) declared.set(name, typeof range === 'string' ? range : '');
    }
  }
  return declared;
};

/** `@types/scope__name` types `@scope/name`; `@types/name` types `name`. */
const typesPackageFor = (name: string): string =>
  `@types/${name.startsWith('@') ? name.slice(1).replace('/', '__') : name}`;

/**
 * The package names a tsconfig `paths` alias answers for. They resolve through the compiler and
 * Bun's own tsconfig reading, never through `node_modules`, so no manifest can declare them.
 */
async function aliasedPackages(root: string): Promise<ReadonlySet<string>> {
  const options = asRecord((await readObject(join(root, 'tsconfig.json')))?.['compilerOptions']);
  const aliases = new Set<string>();
  for (const key of Object.keys(asRecord(options?.['paths']) ?? {})) {
    const name = packageOfSpecifier(key.replace(/\/?\*.*$/, ''));
    if (name !== undefined) aliases.add(name);
  }
  return aliases;
}

const covers = (declared: ReadonlyMap<string, string>, name: string): boolean =>
  declared.has(name) || declared.has(typesPackageFor(name));

/**
 * Whether the file names the package itself. Bun's transpiler injects `react/jsx-dev-runtime` into
 * every `.tsx` scan — an import the author never wrote and the app's `jsxImportSource` replaces —
 * so a package only counts when a quoted specifier in the text starts with its name.
 */
const spelledIn = (source: string, name: string): boolean =>
  new RegExp(`['"\`]${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:['"\`/])`).test(source);

interface Owner {
  readonly dir: string;
  readonly name: string;
  readonly declared: ReadonlyMap<string, string>;
}

export const undeclaredExternalDepFinding = (
  owner: { readonly dir: string },
  dependency: string,
  at: string,
  range?: string,
): Finding => {
  // The range a sibling already pins, when it travels through a shell verbatim: one version of a
  // package across the app, rather than whatever the registry calls latest today.
  const pinned = range === undefined ? dependency : `${dependency}@${range}`;
  const spec = renderFixShellArg(pinned, '') === '' ? dependency : pinned;
  const dev = at.endsWith(FIXTURE_SUFFIX) ? ' --dev' : '';
  return {
    code: 'X_WORKSPACE_EXTERNAL_DEP_UNDECLARED',
    cause: `${at} imports ${dependency}, which neither ${owner.dir}/package.json nor the root package.json declares — it resolves only while another workspace's copy is hoisted`,
    fix: `bun add ${renderFixShellArg(spec, '<the package>')}${dev} --cwd ${renderFixShellArg(owner.dir, '<the workspace directory>')}`,
    docs: ERROR_DOCS_URL,
    at: `${owner.dir}/package.json`,
  };
};

/**
 * The declared registry graph must cover the imported one, per workspace. Workspace siblings are
 * `checkWorkspaceDependencies`' question and are skipped here; `@ultimat3/*` in an app is a
 * registry package like any other and must be declared. Tests are out of scope for the same reason
 * they are there: they resolve through the root's devDependencies and never reach a tarball.
 *
 * One finding per (workspace, package) pair: the fix is one command, not one per import site.
 */
export async function checkExternalDependencies(root: string): Promise<readonly Finding[]> {
  const { nodes } = await scanWorkspaces(root);
  if (nodes.length === 0) return [];
  const workspaceNames = new Set(nodes.map((node) => node.name));
  const aliases = await aliasedPackages(root);
  // The root's own declarations resolve from every workspace under every linker: the root
  // `node_modules` is on each one's lookup path, hoisted or isolated. A SIBLING's is not.
  const rootDeclared = declaredOf(await readObject(join(root, 'package.json')));
  const owners: Owner[] = [];
  for (const node of nodes) {
    const manifest = await readObject(join(root, node.dir, 'package.json'));
    owners.push({ dir: node.dir, name: node.name, declared: declaredOf(manifest) });
  }
  // Deepest directory first: a nested workspace's files are its own, never its parent's.
  owners.sort((left, right) => right.dir.length - left.dir.length);
  // The range the app already uses for a package, from whichever manifest declares it first.
  const ranges = new Map<string, string>();
  for (const [name, range] of rootDeclared) ranges.set(name, range);
  for (const owner of [...owners].sort((left, right) => left.dir.localeCompare(right.dir))) {
    for (const [name, range] of owner.declared) if (!ranges.has(name)) ranges.set(name, range);
  }
  const findings: Finding[] = [];
  const reported = new Set<string>();
  for await (const path of eachSourceFile(root)) {
    if (isTest(path) || isGenerated(path)) continue;
    const owner = owners.find((candidate) => path.startsWith(`${candidate.dir}/`));
    if (owner === undefined) continue;
    const source = await Bun.file(join(root, path)).text();
    for (const name of importedPackages(source, path)) {
      if (isBuiltin(name) || workspaceNames.has(name) || aliases.has(name)) continue;
      if (!spelledIn(source, name)) continue;
      if (covers(owner.declared, name) || covers(rootDeclared, name)) continue;
      const pair = `${owner.dir} ${name}`;
      if (reported.has(pair)) continue;
      reported.add(pair);
      const range = ranges.get(name);
      findings.push(
        undeclaredExternalDepFinding(owner, name, path, range === '' ? undefined : range),
      );
    }
  }
  return findings;
}
