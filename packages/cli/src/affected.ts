// What a diff touches: the changed-file list read out of git, and the workspaces that list forces
// a re-test of — closed TRANSITIVELY over the workspace graph, because A → B → C means an edit in
// C breaks A and a single pass over an unordered list only ever reaches B.
//
// The diff defaults to a REF, never the working tree. Several agents share one checkout here (root
// `CLAUDE.md`, the "Note": no worktrees, "run them as a team in this same checkout"), so a
// working-tree diff returns every other agent's uncommitted work and the "affected" set silently
// widens to nearly the whole monorepo — the command stops narrowing anything and nobody can tell.
// A ref diff is stable under that concurrency; `--dirty` opts back in, which is right for one
// developer iterating alone and wrong as a default here.

// `join`/`relative` are `node:`-only by necessity: Bun exposes no path primitive, and a workspace
// directory is checkout-relative while a caller's scan yields paths relative to its own root.
import { join, relative } from 'node:path';
import { singleLine, UltimateError } from '@ultimat3/core';
import { BadFlagError } from './errors';
import type { ExecResult, Runner } from './exec';
import { execOutput } from './exec';
import type { JsonValue } from './output';
import type { ParsedArgs } from './parse';
import { flagBool, flagString } from './parse';
import type { WorkspaceNode } from './workspace-graph';
import { readWorkspaceGraph } from './workspace-graph';

/** The branch a change is measured against when `--base` says nothing. */
export const DEFAULT_BASE = 'main';

/**
 * Root files that belong to no workspace and change what every workspace compiles to: a compiler
 * option, a lint rule, the root manifest, the resolved dependency tree, the test preload, the app
 * config. A "scoped" run that skipped them reports green over packages the edit just broke.
 *
 * Matched on the WHOLE path — `packages/cli/package.json` is the cli workspace's own file and
 * reaches only cli's dependents, `package.json` at the root reaches everything.
 */
export const ROOT_WIDE_FILES: readonly string[] = [
  'app.config.ts',
  'biome.json',
  'bun.lock',
  'bunfig.toml',
  'package.json',
  'tsconfig.json',
];

/**
 * A file with no compilation unit behind it. A doc or a plan re-checks nothing, so it maps to no
 * workspace at all rather than to the one it happens to sit inside — `packages/cli/README.md` is
 * not a reason to run `packages/cli`'s tests.
 */
const isDoc = (path: string): boolean => path.endsWith('.md');

const owns = (node: WorkspaceNode, path: string): boolean =>
  path === node.dir || path.startsWith(`${node.dir}/`);

/**
 * The workspace a path belongs to, longest directory first: nested workspaces exist (a scaffolded
 * app's `apps/web` inside its own root), and the shorter prefix would swallow the inner one.
 */
export function owningWorkspace(
  graph: readonly WorkspaceNode[],
  path: string,
): WorkspaceNode | undefined {
  let best: WorkspaceNode | undefined;
  for (const node of graph) {
    if (!owns(node, path)) continue;
    if (best === undefined || node.dir.length > best.dir.length) best = node;
  }
  return best;
}

/**
 * Every workspace that depends on one of `seeds`, however many edges away.
 *
 * A queue with a growing cursor, not one pass over `seeds`: with `A → B → C`, one pass answers
 * `{ C, B }` and leaves A untested while the change that broke it is in the diff — a green
 * checkmark on a broken repo, which is the whole reason this command exists rather than each agent
 * inventing its own scoping. `reached` doubles as the cycle guard.
 */
function withDependents(
  graph: readonly WorkspaceNode[],
  seeds: ReadonlySet<string>,
): ReadonlySet<string> {
  const dependents = new Map<string, string[]>();
  for (const node of graph) {
    for (const dependency of node.dependencies) {
      const known = dependents.get(dependency);
      if (known === undefined) dependents.set(dependency, [node.name]);
      else known.push(node.name);
    }
  }
  const reached = new Set(seeds);
  const queue = [...reached];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const name = queue[cursor];
    if (name === undefined) continue;
    for (const dependent of dependents.get(name) ?? []) {
      if (reached.has(dependent)) continue;
      reached.add(dependent);
      queue.push(dependent);
    }
  }
  return reached;
}

export interface AffectedPlan {
  /** Every path the diff reported, verbatim and in git's order. */
  readonly changed: readonly string[];
  /** The subset with no compilation unit behind it, named so an empty answer explains itself. */
  readonly ignored: readonly string[];
  /** The root files that forced every workspace in, empty when none did. */
  readonly rootWide: readonly string[];
  readonly workspaces: readonly WorkspaceNode[];
}

const byName = (a: WorkspaceNode, b: WorkspaceNode): number => (a.name > b.name ? 1 : -1);

/**
 * Pure: the graph and the file list in, the plan out. No git, no disk — so the transitive rule is
 * testable without a checkout whose state would decide the verdict.
 */
export function planAffected(
  graph: readonly WorkspaceNode[],
  changed: readonly string[],
): AffectedPlan {
  const ignored = changed.filter(isDoc);
  const considered = changed.filter((path) => !isDoc(path));
  const rootWide = considered.filter((path) => ROOT_WIDE_FILES.includes(path));
  if (rootWide.length > 0) {
    return { changed, ignored, rootWide, workspaces: [...graph].sort(byName) };
  }
  const seeds = new Set<string>();
  for (const path of considered) {
    const node = owningWorkspace(graph, path);
    if (node !== undefined) seeds.add(node.name);
  }
  const reached = withDependents(graph, seeds);
  return {
    changed,
    ignored,
    rootWide,
    workspaces: graph.filter((node) => reached.has(node.name)).sort(byName),
  };
}

/**
 * How the calling command spells this scoping, so a `fix:` re-runs the invocation that actually
 * failed. `x test --base main` is refused by `x test` itself — without `--affected` the flag
 * narrows nothing — so a fix line that dropped it would reproduce its own failure, verbatim.
 */
const invocationOf = (command: string): string =>
  command === 'affected' ? 'x affected' : `x ${command} --affected`;

export interface AffectedSelection {
  readonly base: string;
  readonly dirty: boolean;
}

/**
 * One reader for `--base` and `--dirty`, shared by `x affected` and `x test --affected`: two
 * readers would be two answers to "what is this diff measured against", and the second command's
 * scoping is only trustworthy if it is the first command's.
 */
export function readAffectedSelection(args: ParsedArgs, command: string): AffectedSelection {
  const base = flagString(args, 'base') ?? DEFAULT_BASE;
  if (base.trim().length === 0) {
    throw new BadFlagError({
      flag: 'base',
      command,
      reason: 'needs a git ref and got an empty value',
      fix: `${invocationOf(command)} --base ${DEFAULT_BASE} --json`,
    });
  }
  return { base, dirty: flagBool(args, 'dirty') };
}

const git = (runner: Runner, cwd: string, args: readonly string[]): Promise<ExecResult> =>
  runner(['git', ...args], { cwd });

/** NUL-delimited, so a path holding a space, a quote or a newline survives the read intact. */
const paths = (stdout: string): readonly string[] =>
  stdout.split('\0').filter((path) => path.length > 0);

/**
 * The checkout's own root, which is what every path git prints is relative to — so it is also the
 * root the workspace graph has to be read from, or a `packages/cli/...` path would be matched
 * against dirs resolved somewhere else.
 */
export async function gitRoot(runner: Runner, cwd: string, command: string): Promise<string> {
  const result = await git(runner, cwd, ['rev-parse', '--show-toplevel']);
  if (result.ok) return result.stdout.trim();
  throw new UltimateError({
    code: 'X_CLI_UNEXPECTED',
    cause: `x ${command} reads its diff from git and "git rev-parse --show-toplevel" exited ${result.code} in ${cwd}: ${singleLine(execOutput(result))}`,
    fix: `run x ${command} from inside a git checkout — confirm with: git rev-parse --show-toplevel`,
  });
}

export interface ChangedFilesOptions {
  readonly cwd: string;
  readonly command: string;
  readonly selection: AffectedSelection;
}

/**
 * `<base>...HEAD` — three dots, so the answer is "what this branch changed since it forked",
 * never "how this branch differs from a base that has moved on underneath it". A two-dot diff
 * reports someone else's merged commits as this branch's work.
 *
 * `--dirty` unions the working tree on top: tracked edits against HEAD, plus untracked files that
 * are not ignored. Both halves are needed — a brand-new file is invisible to `git diff`.
 */
export async function changedFiles(
  runner: Runner,
  options: ChangedFilesOptions,
): Promise<readonly string[]> {
  const { base, dirty } = options.selection;
  const resolved = await git(runner, options.cwd, [
    'rev-parse',
    '--verify',
    '--quiet',
    `${base}^{commit}`,
  ]);
  if (!resolved.ok) {
    throw new BadFlagError({
      flag: 'base',
      command: options.command,
      reason: `git resolves no commit named "${base}" in this checkout`,
      fix: `git fetch --no-tags origin ${base}:${base}, then re-run: ${invocationOf(options.command)} --base ${base} --json`,
    });
  }
  const runs = [
    await git(runner, options.cwd, ['diff', '--name-only', '-z', `${base}...HEAD`]),
    ...(dirty
      ? [
          await git(runner, options.cwd, ['diff', '--name-only', '-z', 'HEAD']),
          await git(runner, options.cwd, ['ls-files', '-z', '--others', '--exclude-standard']),
        ]
      : []),
  ];
  const failed = runs.find((run) => !run.ok);
  if (failed !== undefined) {
    throw new UltimateError({
      code: 'X_CLI_UNEXPECTED',
      cause: `"${failed.command.join(' ')}" exited ${failed.code} in ${options.cwd}: ${singleLine(execOutput(failed))}`,
      fix: `run it yourself to see why: ${failed.command.join(' ')}`,
    });
  }
  return [...new Set(runs.flatMap((run) => paths(run.stdout)))].sort();
}

/**
 * One resolved answer, in the two shapes its two callers need: the `plan` (`x affected` reports
 * it) and the `prefixes` (`x test --affected` selects with them). `plan.workspaces` holds dirs
 * relative to the CHECKOUT; `prefixes` is the same set relative to the directory the caller scans,
 * which is what its own paths are relative to.
 */
export interface AffectedScope {
  readonly selection: AffectedSelection;
  /** The checkout root git reported every path against. */
  readonly root: string;
  readonly plan: AffectedPlan;
  readonly prefixes: readonly string[];
}

/**
 * An empty prefix means the scan root IS an affected workspace, so every path it yields is in
 * scope; a prefix starting with `..` is a workspace outside that root, which has no file there to
 * select and must not be allowed to collapse into a match-everything empty string.
 */
const scopePrefixes = (root: string, cwd: string, dirs: readonly string[]): readonly string[] =>
  dirs
    .map((dir) => relative(cwd, join(root, dir)).split('\\').join('/'))
    .filter((path) => !path.startsWith('..'));

export const inScope = (path: string, prefixes: readonly string[]): boolean =>
  prefixes.some((prefix) => prefix === '' || path === prefix || path.startsWith(`${prefix}/`));

export interface AffectedScopeOptions {
  readonly runner: Runner;
  /** The directory the caller scans, which the prefixes come back relative to. */
  readonly cwd: string;
  readonly args: ParsedArgs;
  readonly command: string;
}

/**
 * The whole answer, resolved once: the diff, the graph, the closure and the prefixes. `x affected`
 * and `x test --affected` both come through here, so the second can never scope a run differently
 * from what the first reports — an invented scoping that misses a transitive dependent is a green
 * checkmark on a broken repo, and two implementations is how one of them gets it wrong.
 */
export async function affectedScope(options: AffectedScopeOptions): Promise<AffectedScope> {
  const selection = readAffectedSelection(options.args, options.command);
  const root = await gitRoot(options.runner, options.cwd, options.command);
  const plan = planAffected(
    await readWorkspaceGraph(root),
    await changedFiles(options.runner, { cwd: root, command: options.command, selection }),
  );
  return {
    selection,
    root,
    plan,
    prefixes: scopePrefixes(
      root,
      options.cwd,
      plan.workspaces.map((workspace) => workspace.dir),
    ),
  };
}

/** The scope as `--json` carries it, from whichever command narrowed by it. */
export const affectedScopeJson = (scope: AffectedScope): JsonValue => ({
  base: scope.selection.base,
  dirty: scope.selection.dirty,
  changed: scope.plan.changed.length,
  workspaces: scope.plan.workspaces.map((workspace) => workspace.dir),
});
