// Workspace enumeration. Reads the real package.json files rather than the tier table, so a
// package that exists on disk but is missing from the table is visible instead of invisible.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { renderThrowable } from '@ultimat3/core';
import { ScriptError } from './script-error';
import { tierOf } from './tiers';

export interface Workspace {
  /** Directory name under packages/, which is also the name after the @ultimat3/ scope. */
  readonly dir: string;
  readonly name: string;
  readonly version: string;
  readonly private: boolean;
  readonly path: string;
  readonly tier: number;
}

export interface PackageJson {
  readonly name?: string;
  readonly version?: string;
  readonly private?: boolean;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

/** What this module enumerates, exported so a refusal can name what it scanned. */
export const WORKSPACE_GLOB = 'packages/*/package.json';

/**
 * One workspace manifest's three states — the same union `RootManifest` below carries, for the
 * same reason and one directory down.
 *
 * #281: `listWorkspaces` read every one of these with `(await Bun.file(path).json()) as PackageJson`
 * — an unchecked cast and no `catch` — so one trailing comma in `packages/schema/package.json`
 * left a bare `SyntaxError: Failed to parse JSON` out of the module `release.ts`,
 * `registry-audit.ts`, `version-stamps.ts`, `release-facts.ts` and `list-workspaces.ts` all sit on.
 * No path, no code, no fix: an operator cutting a release learned that SOME json SOMEWHERE was
 * broken. `readRootManifest` had been hardened against exactly this and the sibling had not.
 *
 * A cast is the other half of the same defect, and `readRootManifest`'s comment already says it:
 * JSON that parses is not JSON of the right SHAPE. `["@ultimat3/schema"]` and `{"version": 9}`
 * both parse, both satisfy the cast, and both reached `manifest.version ?? '0.0.0'` — so a
 * mistyped version left here as the string `0.0.0` and read downstream as a workspace out of
 * lockstep, which is a finding against the wrong file.
 */
export type WorkspaceManifest =
  | { readonly kind: 'read'; readonly manifest: PackageJson }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unparsable'; readonly problem: string };

const OPTIONAL: Readonly<Record<string, 'string' | 'boolean'>> = {
  name: 'string',
  version: 'string',
  private: 'boolean',
};

/** Parsed from `unknown`, never cast. Never throws — the caller decides between report and refuse. */
export async function readWorkspaceManifest(path: string): Promise<WorkspaceManifest> {
  const file = Bun.file(path);
  if (!(await file.exists())) return { kind: 'absent' };
  let parsed: unknown;
  try {
    parsed = await file.json();
  } catch (error) {
    // `renderThrowable` and not `${error}`: the thrown value is genuinely unknown here, and core's
    // renderer is the one spelling that cannot itself throw on a hostile `toString`.
    return { kind: 'unparsable', problem: renderThrowable(error) };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      kind: 'unparsable',
      problem: 'is valid JSON and not an object, so it names no package',
    };
  }
  const record = parsed as Record<string, unknown>;
  for (const [key, want] of Object.entries(OPTIONAL)) {
    // `Object.hasOwn` first: `record` came off `JSON.parse`, which gives an ordinary prototype, so
    // a manifest with no `"name"` answers `Object.prototype.constructor` for `record['constructor']`
    // — a function, never a string, and so a manifest reported as broken for a key nobody wrote.
    const held: unknown = Object.hasOwn(record, key) ? record[key] : undefined;
    if (held !== undefined && typeof held !== want) {
      return { kind: 'unparsable', problem: `"${key}" is present and is not a ${want}` };
    }
  }
  for (const key of ['dependencies', 'devDependencies']) {
    const held: unknown = Object.hasOwn(record, key) ? record[key] : undefined;
    if (held === undefined) continue;
    if (typeof held !== 'object' || held === null || Array.isArray(held)) {
      return { kind: 'unparsable', problem: `"${key}" is present and is not an object of ranges` };
    }
    for (const [name, range] of Object.entries(held as Record<string, unknown>)) {
      if (typeof range !== 'string') {
        return { kind: 'unparsable', problem: `"${key}"."${name}" is not a version range string` };
      }
    }
  }
  return { kind: 'read', manifest: record as PackageJson };
}

/**
 * The same read, refusing instead of reporting — for the callers that enumerate `workspaceManifests`
 * and have nowhere to put a third state. `relativeTo` is what the refusal NAMES, so the operator
 * gets a repo-relative path rather than whatever absolute one the glob happened to build.
 */
export async function requireWorkspaceManifest(
  path: string,
  relativeTo: string,
): Promise<PackageJson> {
  const read = await readWorkspaceManifest(path);
  if (read.kind === 'read') return read.manifest;
  throw new ScriptError({
    code: 'X_WORKSPACE_MANIFEST_UNREADABLE',
    cause: `${relativeTo} ${read.kind === 'absent' ? 'vanished between the glob and the read' : read.problem}, and every release tool in scripts/ enumerates the workspaces through this module`,
    fix: `bun -e "console.log(await Bun.file('${relativeTo}').json())"   # prints the parse error; repair ${relativeTo} until it is a JSON object whose "name" and "version" are strings, then: bun run workspaces:list`,
  });
}

export async function listWorkspaces(root: string): Promise<readonly Workspace[]> {
  const glob = new Bun.Glob(WORKSPACE_GLOB);
  const out: Workspace[] = [];
  for await (const relative of glob.scan({ cwd: root, absolute: false })) {
    // Refuse rather than skip. A skipped workspace is a package silently missing from the publish
    // list `release.ts` derives from this call, which is worse than a red release run.
    // `ScriptError`'s message carries the code, the cause AND the fix, so even a rejection that
    // nothing catches prints instructions rather than a stack trace.
    const manifest = await requireWorkspaceManifest(join(root, relative), relative);
    const dir = relative.split('/')[1] ?? '';
    out.push({
      dir,
      name: manifest.name ?? `@ultimat3/${dir}`,
      version: manifest.version ?? '0.0.0',
      private: manifest.private === true,
      path: join(root, 'packages', dir),
      tier: tierOf(dir),
    });
  }
  out.sort((a, b) => a.tier - b.tier || a.dir.localeCompare(b.dir));
  return out;
}

/** Publish order: tier 0 first, so a dependency is always on the registry before its dependants. */
export const publishOrder = (workspaces: readonly Workspace[]): readonly Workspace[] =>
  workspaces.filter((workspace) => !workspace.private);

/**
 * What the root `package.json` answered — THREE facts, because a caller has to be able to tell
 * them apart. An empty `patterns` is a repo declaring no workspaces; `absent` is a directory that
 * is not a repo; `unparsable` is a repo whose manifest is broken. Reading the second as the first
 * is how a rule reports a clean tree it never scanned, and reading the THIRD as the second is how a
 * root `package.json` with a trailing comma was reported as "not a repo" — whose fix line,
 * `scripts/version-stamps.ts`'s `run this from the repository root`, names the directory the
 * operator is already standing in and cannot be run.
 */
export type RootManifest =
  | { readonly kind: 'read'; readonly patterns: readonly string[] }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unparsable'; readonly problem: string };

/**
 * `workspaces` as Bun writes it — an array of glob strings — or the sentence saying what it is
 * instead. Parsed from `unknown` rather than cast: JSON that parses is not JSON of the right
 * SHAPE, and a cast made every other shape read as an array. `"workspaces": "apps/*"` (the string
 * npm also accepts) let `workspaceManifests` iterate the string's CHARACTERS, so it globbed
 * `a/package.json`, `p/package.json`, … and reported a clean tree it had never scanned; the object
 * form yarn accepts, `{ "packages": [...] }`, is not iterable at all and threw a `TypeError` out
 * of a `HostCheck` — the stack trace this module's own header says must never leave here.
 */
const declaredPatterns = (
  manifest: unknown,
): { readonly patterns: readonly string[] } | { readonly problem: string } => {
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    return { problem: 'is valid JSON and not an object, so it declares no workspaces' };
  }
  const declared: unknown = (manifest as Record<string, unknown>)['workspaces'];
  if (declared === undefined) return { patterns: [] };
  if (!Array.isArray(declared) || declared.some((pattern) => typeof pattern !== 'string')) {
    return { problem: '"workspaces" is not an array of glob strings' };
  }
  return { patterns: declared as readonly string[] };
};

/** Never throws: this runs inside a `HostCheck`, where a throw is a stack trace, not a finding. */
export async function readRootManifest(root: string): Promise<RootManifest> {
  const file = Bun.file(join(root, 'package.json'));
  if (!(await file.exists())) return { kind: 'absent' };
  let manifest: unknown;
  try {
    manifest = await file.json();
  } catch (error) {
    // The thrown value is genuinely unknown, and core's renderer is the one spelling that cannot
    // itself throw on a hostile `toString` — the rule `packages/cli/src/cmd-new.ts` states.
    return { kind: 'unparsable', problem: renderThrowable(error) };
  }
  const read = declaredPatterns(manifest);
  return 'problem' in read
    ? { kind: 'unparsable', problem: read.problem }
    : { kind: 'read', patterns: read.patterns };
}

/**
 * The `workspaces` patterns the root manifest declares, or `undefined` when it could not be read.
 * The two unreadable states are one answer HERE on purpose: this is the discovery half, and both
 * mean "scan nothing". A caller REPORTING the condition reads `readRootManifest` instead.
 */
export async function rootWorkspacePatterns(root: string): Promise<readonly string[] | undefined> {
  const manifest = await readRootManifest(root);
  return manifest.kind === 'read' ? manifest.patterns : undefined;
}

/**
 * Every workspace manifest the root package.json claims, `packages/*` and the reference app alike.
 * A release rewrites `@ultimat3/*` pins in all of them: the example workspaces are private and
 * never publish, but they resolve those pins out of the same lockfile, so one left at the old
 * version makes `bun install --frozen-lockfile` reach npm for a version that is not there.
 *
 * A root with no readable manifest answers an EMPTY list rather than throwing. This runs inside
 * `x verify`'s `manifest` HostCheck, where a throw is caught as an internal failure and the
 * operator gets a stack trace where a finding belonged — measured: three `verify.test.ts` cases
 * drive the step against a temp directory holding one wiki page. `readManifest` in
 * `packages/cli/src/workspace-graph.ts` is the precedent: skip and report, never throw. Reporting
 * is `rootWorkspacePatterns` above, so the skip cannot become a hiding place.
 */
export async function workspaceManifests(root: string): Promise<readonly string[]> {
  const paths: string[] = [];
  for (const pattern of (await rootWorkspacePatterns(root)) ?? []) {
    const glob = new Bun.Glob(`${pattern}/package.json`);
    for await (const relative of glob.scan({ cwd: root, absolute: false })) {
      paths.push(join(root, relative));
    }
  }
  return paths.sort();
}

export const hasFile = (workspace: Workspace, file: string): boolean =>
  existsSync(join(workspace.path, file));
