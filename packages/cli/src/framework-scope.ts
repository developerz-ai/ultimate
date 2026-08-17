// Where the `@ultimat3` packages THIS `x` is pinned against live on disk. One resolver, because
// two answers to "which framework is installed" is two answers to every question read off it —
// the docs `x docs` quotes and the `fix:` lines `x errors explain` projects come from the same
// directory or they describe different builds.

// `node:path` because Bun ships no path module: `dirname` walks up from a resolved package.json
// to its scope directory, which is string surgery `Bun.resolveSync` does not offer.
import { dirname } from 'node:path';

/**
 * Resolved from the CLI's own dependency on `@ultimat3/core` rather than from the user's cwd:
 * these are the packages this `x` would actually run. Resolution follows the symlink, so it lands
 * on `node_modules/@ultimat3` in an app and on `packages/` in this monorepo — one code path for
 * both, and a directory listing rather than a hardcoded package list, because an app installs the
 * subset it uses.
 *
 * `undefined` means the CLI cannot see its own dependency, which is a broken install and not
 * merely an undocumented one; every caller reports that rather than answering emptily.
 */
export function frameworkScopeDir(): string | undefined {
  try {
    return dirname(dirname(Bun.resolveSync('@ultimat3/core/package.json', import.meta.dir)));
  } catch {
    return undefined;
  }
}
