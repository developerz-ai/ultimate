// Workspace enumeration. Reads the real package.json files rather than the tier table, so a
// package that exists on disk but is missing from the table is visible instead of invisible.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
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
 * The `workspaces` patterns the root manifest declares, or `undefined` when there is no readable
 * root manifest at all.
 *
 * The two answers are different facts and a caller has to be able to tell them apart: an empty
 * list is a repo declaring no workspaces, `undefined` is a directory that is not a repo. Reading
 * the second as the first is how a rule reports a clean tree it never scanned.
 */
export async function rootWorkspacePatterns(root: string): Promise<readonly string[] | undefined> {
  try {
    const manifest = (await Bun.file(join(root, 'package.json')).json()) as {
      readonly workspaces?: readonly string[];
    };
    return manifest.workspaces ?? [];
  } catch {
    return undefined;
  }
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
