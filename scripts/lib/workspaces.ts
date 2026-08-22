// Workspace enumeration. Reads the real package.json files rather than the tier table, so a
// package that exists on disk but is missing from the table is visible instead of invisible.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { renderThrowable } from '@ultimat3/core';
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

interface PackageJson {
  readonly name?: string;
  readonly version?: string;
  readonly private?: boolean;
}

export async function listWorkspaces(root: string): Promise<readonly Workspace[]> {
  const glob = new Bun.Glob('packages/*/package.json');
  const out: Workspace[] = [];
  for await (const relative of glob.scan({ cwd: root, absolute: false })) {
    const path = join(root, relative);
    const manifest = (await Bun.file(path).json()) as PackageJson;
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
