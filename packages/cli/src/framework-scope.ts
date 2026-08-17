// Where the `@ultimat3` packages THIS `x` is pinned against live on disk. One resolver, because
// two answers to "which framework is installed" is two answers to every question read off it —
// the docs `x docs` quotes and the `fix:` lines `x errors explain` projects come from the same
// directory or they describe different builds.

// `node:fs`/`node:path` because Bun ships neither: `dirname` walks a resolved module up to the
// directory that owns it, and `existsSync` is what says which directory that is.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Deep enough for `src/index.ts` and for any entry an `exports` map could point at, shallow enough
 * that a resolver answering something unexpected stops rather than walking to `/`.
 */
const MAX_DEPTH = 6;

/**
 * Resolved from the CLI's own dependency on `@ultimat3/core` rather than from the user's cwd:
 * these are the packages this `x` would actually run. Resolution follows the symlink, so a
 * workspace-linked app lands on the same `packages/` this monorepo does — one code path for both,
 * and a directory listing rather than a hardcoded package list, because an app installs the
 * subset it uses.
 *
 * The **exported entry** is what gets resolved, never `@ultimat3/core/package.json`: every package
 * here declares `"exports": { ".": "./src/index.ts" }` and nothing else, so a subpath specifier is
 * asking a resolver for something the package does not publish. Bun 1.3 happens to answer it
 * anyway; a resolver that enforced `exports` would answer `undefined`, and the failure would be
 * silent — `x docs` reporting no installed packages and `x errors explain` reporting that no
 * framework raises the code. Walking up from the entry to the directory that owns its
 * `package.json` depends on nothing but the entry that is already imported.
 *
 * `undefined` means the CLI cannot see its own dependency, which is a broken install and not
 * merely an undocumented one; every caller reports that rather than answering emptily.
 */
export function frameworkScopeDir(): string | undefined {
  let dir: string;
  try {
    dir = dirname(Bun.resolveSync('@ultimat3/core', import.meta.dir));
  } catch {
    return undefined;
  }
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    if (existsSync(join(dir, 'package.json'))) return dirname(dir);
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}
