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

export const hasFile = (workspace: Workspace, file: string): boolean =>
  existsSync(join(workspace.path, file));
