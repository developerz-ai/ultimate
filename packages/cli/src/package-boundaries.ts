// `packages/` may not import `apps/`: a shared package that depends on one app is no longer shared.
// Its own rule and its own read, beside `app-boundaries.ts`: `readAppSources` is what the surface
// graph walks, and a package source joining that graph would change every surface verdict too.
// No per-package tiers: the layout of an app's `packages/` is the app's.

import { existsSync } from 'node:fs'; // why: a synchronous directory probe; Bun.file answers files.
// why: Bun ships no `Bun.*` path API: `joinPath` reaches a file on disk with the host's separator.
import { join as joinPath } from 'node:path';
// why: no Bun path API; the POSIX variants resolve specifiers against repo-relative keys, which
// are POSIX on every host.
import { dirname, join, normalize } from 'node:path/posix';
import { ERROR_DOCS_URL, stringField } from '@ultimat3/core';
import type { SourceFile } from './app-boundaries';
import { commentSafe } from './comment-safe';
import { scanRuntimeImports } from './import-scan';
import type { Finding } from './output';
import { hasPathSegment } from './path-segments';
import { toPosix } from './posix-path';
import { isEntityModule } from './templates/entity-module';

const DB_SOURCES = 'packages/db/src/';

/** Each app workspace's package name → its directory: `@acme/web` → `apps/web`. */
export type AppWorkspaces = ReadonlyMap<string, string>;

/** Where a specifier lands inside `apps/`, or `undefined` when it lands anywhere else. */
const appTarget = (
  from: string,
  specifier: string,
  workspaces: AppWorkspaces,
): string | undefined => {
  if (specifier.startsWith('.')) {
    const target = normalize(join(dirname(from), specifier));
    return target.startsWith('apps/') ? target : undefined;
  }
  if (specifier.startsWith('apps/')) return specifier;
  for (const [name, dir] of workspaces) {
    if (specifier === name) return dir;
    if (specifier.startsWith(`${name}/`)) return `${dir}${specifier.slice(name.length)}`;
  }
  return undefined;
};

/**
 * The one generated exception: `x g entity` adds its entity to the typed handle and `x new` to
 * `schema.ts`, both in `packages/db/src/`, reading it from the slice that declares it
 * (`templates/scaffold-db-client.ts`). An entity module, exactly: a `repo` there is a violation.
 */
const isDbEntry = (from: string, target: string): boolean =>
  from.startsWith(DB_SOURCES) && isEntityModule(`${target}.ts`);

/** Pure, so a caller holding the text needs no disk. Runtime imports only: `import type` erases. */
export function packageToAppFindings(
  files: readonly SourceFile[],
  workspaces: AppWorkspaces,
): readonly Finding[] {
  return files.flatMap((file) =>
    scanRuntimeImports(file).flatMap((specifier) => {
      const target = appTarget(file.path, specifier, workspaces);
      if (target === undefined || isDbEntry(file.path, target)) return [];
      return [
        {
          code: 'X_BOUNDARY_PACKAGE_TO_APP',
          cause: `package source imports an app ("${specifier}", in ${target}) — a package an app depends on cannot depend back on one app`,
          fix: `x verify --only boundaries --json   # after moving ${commentSafe(target)} into the package, or importing in the opposite direction`,
          docs: ERROR_DOCS_URL,
          at: file.path,
        },
      ];
    }),
  );
}

const PACKAGE_GLOB = 'packages/*/**/*.{ts,tsx}';

/** Every package source of an app: never a test, a dependency or a build's output. */
export async function readPackageSources(root: string): Promise<readonly SourceFile[]> {
  const files: SourceFile[] = [];
  for await (const path of new Bun.Glob(PACKAGE_GLOB).scan({ cwd: root, absolute: false })) {
    if (hasPathSegment(path, 'node_modules') || hasPathSegment(path, 'dist')) continue;
    if (path.includes('.test.') || path.endsWith('.d.ts')) continue;
    const posix = toPosix(path);
    files.push({ path: posix, source: await Bun.file(joinPath(root, posix)).text() });
  }
  return files.sort((left, right) => (left.path < right.path ? -1 : 1));
}

/** `apps/*\/package.json`'s names, or `undefined` for a tree that holds no app at all. */
const readAppWorkspaces = async (root: string): Promise<AppWorkspaces | undefined> => {
  // A root with no `apps/` at all, before the walk: Bun's glob throws on a missing directory.
  if (!existsSync(joinPath(root, 'apps'))) return undefined;
  const found = new Map<string, string>();
  for await (const path of new Bun.Glob('apps/*/package.json').scan({ cwd: root })) {
    const manifest: unknown = await Bun.file(joinPath(root, path)).json();
    // `stringField`: a parsed manifest is a value this process did not build (`caught-value-reads`).
    const name = stringField(manifest, 'name');
    if (name !== undefined) found.set(name, dirname(toPosix(path)));
  }
  return found;
};

/**
 * The rule over a real tree. A tree with no `apps/` answers nothing: that is the framework's own
 * repository, whose `packages/` is 3,000 files this rule has nothing to say about.
 */
export async function packageBoundaryFindings(root: string): Promise<readonly Finding[]> {
  const workspaces = await readAppWorkspaces(root);
  if (workspaces === undefined) return [];
  return packageToAppFindings(await readPackageSources(root), workspaces);
}
