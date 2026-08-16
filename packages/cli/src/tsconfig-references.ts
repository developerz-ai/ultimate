// One rule: every published workspace is in the root build graph. `bun run typecheck` is `tsc -b`,
// which compiles referenced projects and nothing else — so a package no reference names is a
// package the gate's `typecheck` step reports green over without having read a line of it.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { docsFor } from './error-codes';
import type { Finding } from './output';

const ROOT_TSCONFIG = 'tsconfig.json';

/** `./packages/cli`, `packages/cli/` and `packages/cli` are one project; the JSON allows all three. */
const normalize = (path: string): string => path.replace(/^\.\//, '').replace(/\/+$/, '');

/**
 * `undefined` means "this root does not use project references" — a different repo shape, not an
 * empty graph. A scaffolded app is that shape (`extends` + `include`, no references at all), and
 * telling its author to add an entry to a list that does not exist is a fix that makes the build
 * worse. A tsconfig that will not parse is `typecheck`'s to report, with tsc's own message.
 */
async function referencedPaths(root: string): Promise<ReadonlySet<string> | undefined> {
  const path = join(root, ROOT_TSCONFIG);
  if (!existsSync(path)) return undefined;
  const payload: unknown = await Bun.file(path)
    .json()
    .catch(() => undefined);
  const references =
    typeof payload === 'object' && payload !== null
      ? (payload as { references?: unknown }).references
      : undefined;
  if (!Array.isArray(references)) return undefined;
  return new Set(
    references.flatMap((entry: unknown) => {
      const value =
        typeof entry === 'object' && entry !== null
          ? (entry as { path?: unknown }).path
          : undefined;
      return typeof value === 'string' ? [normalize(value)] : [];
    }),
  );
}

/**
 * The edit, spelled out: the array to add to, the entry to add, and the command that proves it
 * took. `tsc -b` is the same one the gate's `typecheck` step runs, so a reader who runs the fix
 * runs the check.
 */
export const unreferencedFinding = (dir: string): Finding => ({
  code: 'X_PACKAGE_UNREFERENCED',
  cause: `packages/${dir} is a published workspace and ${ROOT_TSCONFIG} has no reference to it, so tsc -b never builds it`,
  fix: `add { "path": "./packages/${dir}" } to "references" in ${ROOT_TSCONFIG}, then run bunx tsc -b --pretty false`,
  docs: docsFor('X_PACKAGE_UNREFERENCED'),
  at: ROOT_TSCONFIG,
});

/**
 * Published workspaces only. A private package is not a shipped contract and a generated app's
 * `packages/*` are all private, so this asks nothing of an app that never publishes — the same
 * line `checkPublishShape` already draws.
 */
export async function checkRootReferences(
  root: string,
  dirs: readonly string[],
): Promise<readonly Finding[]> {
  const referenced = await referencedPaths(root);
  if (referenced === undefined) return [];
  return dirs
    .filter((dir) => !referenced.has(`packages/${dir}`))
    .map((dir) => unreferencedFinding(dir));
}
