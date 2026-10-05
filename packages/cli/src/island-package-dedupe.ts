// One copy of each framework package per island chunk: the app's. `island-solid-dedupe.ts`'s rule,
// for `@ultimat3/*`. The framework ships in lockstep, so the copy the APP installed is the right
// one for every importer, and a second copy is a second registry, never a feature.
//
// Without it `Bun.build` resolves each import from the importing file, so a package nested under
// another (`node_modules/@ultimat3/ui/node_modules/@ultimat3/core`) is a second module. Linux hid
// it: Bun links a `file:` package file by file with symlinks, and a realpath folds every nest into
// one. Windows links without symlinks, so the scaffold smoke's `/posts` island shipped `core` and
// `schema` more than once: 82,106 B against 60,649 B on Linux, over a 64kb budget.
// Reproduced on Linux by replacing those links with copies: 75,023 B, and 59,926 B with this plugin.

// why: Bun ships no path API and no existence check; `dirname` walks up the way Node resolution
// does, `join` builds each candidate, and `existsSync` asks whether one is installed.
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BunPlugin } from 'bun';
import { conditionTarget } from './island-solid-dedupe';

/** `@ultimat3/<name>` and every subpath of it. */
export const FRAMEWORK_SPECIFIER = /^@ultimat3\/[^/]+(?:\/.*)?$/;

/** `@ultimat3/core/page` → `{ name: '@ultimat3/core', subpath: './page' }`. */
export function splitFrameworkSpecifier(specifier: string): {
  readonly name: string;
  readonly subpath: string;
} {
  const [scope = '', pkg = '', ...rest] = specifier.split('/');
  return { name: `${scope}/${pkg}`, subpath: rest.length === 0 ? '.' : `./${rest.join('/')}` };
}

export interface AppPackage {
  /** The installed package's directory — every export target is joined onto it. */
  readonly dir: string;
  /** Its `exports` map, verbatim. */
  readonly exports: unknown;
}

/**
 * The copy the app's own entry would find: `node_modules/<name>` in the app root, then each
 * directory above it. `null` when none is installed there — a package only nested under another
 * is left to Bun, which resolves it from its importer as before.
 */
export async function resolveAppPackage(root: string, name: string): Promise<AppPackage | null> {
  for (let dir = root; ; dir = dirname(dir)) {
    const manifest = join(dir, 'node_modules', name, 'package.json');
    if (existsSync(manifest)) {
      const parsed = (await Bun.file(manifest).json()) as { readonly exports?: unknown };
      // The REAL directory: Bun keys a module by its realpath, so returning the `node_modules/…`
      // spelling of a symlinked package would bundle it a second time beside every file reached
      // through its real path — the duplication this plugin exists to remove.
      return { dir: realpathSync(dirname(manifest)), exports: parsed.exports };
    }
    if (dirname(dir) === dir) return null;
  }
}

/** Where `subpath` lands in the app's copy, under the browser conditions, or `undefined`. */
export function appPackagePath(pkg: AppPackage, subpath: string): string | undefined {
  const exports = pkg.exports;
  if (exports === null || typeof exports !== 'object' || !Object.hasOwn(exports, subpath)) {
    return undefined;
  }
  const target = conditionTarget((exports as Record<string, unknown>)[subpath]);
  return target === undefined ? undefined : join(pkg.dir, target);
}

/** Installed beside `solidDedupePlugin`, before any plugin loads a file. One lookup per package. */
export function frameworkDedupePlugin(root: string): BunPlugin {
  const found = new Map<string, Promise<AppPackage | null>>();
  return {
    name: 'ultimate-framework-dedupe',
    setup(build): void {
      build.onResolve({ filter: FRAMEWORK_SPECIFIER }, async (args) => {
        const { name, subpath } = splitFrameworkSpecifier(args.path);
        let pending = found.get(name);
        if (pending === undefined) {
          pending = resolveAppPackage(root, name);
          found.set(name, pending);
        }
        const pkg = await pending;
        const path = pkg === null ? undefined : appPackagePath(pkg, subpath);
        if (path === undefined) return undefined;
        // Only when Bun's own answer is a SECOND copy. A path a plugin returns loses its package's
        // `sideEffects`, so taking over every import shipped ~2.2 KB of untree-shaken core in each
        // island of examples/dummy (21,945 → 24,202 B on /pricing) while folding nothing on Linux.
        return sameModule(path, args.path, args.importer) ? undefined : { path };
      });
    },
  };
}

/** Whether Bun, left alone, resolves `specifier` from `importer` to `path` itself (by realpath). */
export function sameModule(path: string, specifier: string, importer: string): boolean {
  try {
    return realpathSync(Bun.resolveSync(specifier, dirname(importer))) === realpathSync(path);
  } catch {
    // Unresolvable from the importer: the app's copy is the only answer there is.
    return false;
  }
}

/**
 * Whether any installed `@ultimat3/*` package carries a NESTED framework package that is a real
 * directory rather than a symlink — a second copy no realpath folds, which is a `file:` install on
 * Windows. Only then is the plugin installed: Bun stops honouring a package's `sideEffects` for
 * every import an `onResolve` hook sees, even one it answers `undefined` to, so a hook on a tree
 * with nothing to fold cost each island of examples/dummy ~2.2 KB (21,945 → 24,202 B on /pricing).
 */
export function hasNestedFrameworkCopies(root: string): boolean {
  for (let dir = root; ; dir = dirname(dir)) {
    const scope = join(dir, 'node_modules', '@ultimat3');
    if (existsSync(scope)) {
      for (const pkg of readdirSync(scope)) {
        const nested = join(scope, pkg, 'node_modules', '@ultimat3');
        if (!existsSync(nested)) continue;
        for (const inner of readdirSync(nested)) {
          if (!lstatSync(join(nested, inner)).isSymbolicLink()) return true;
        }
      }
    }
    if (dirname(dir) === dir) return false;
  }
}

/** The plugin list entry: the dedupe when a nested copy exists, nothing otherwise. */
export function frameworkDedupePlugins(
  root: string,
  platform: NodeJS.Platform = process.platform,
): readonly BunPlugin[] {
  // Windows always: a `file:` install there links packages through junctions Bun does not fold,
  // so the same file is reached under two spellings — the windows job's `/posts` shipped 80.2kb
  // against Linux's 60kb with only the nested-copy check deciding.
  return platform === 'win32' || hasNestedFrameworkCopies(root)
    ? [frameworkDedupePlugin(root)]
    : [];
}
