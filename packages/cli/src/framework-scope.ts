// Where the `@ultimat3` packages THIS `x` is pinned against live on disk. One resolver, because
// two answers to "which framework is installed" is two answers to every question read off it —
// the docs `x docs` quotes and the `fix:` lines `x errors explain` projects come from the same
// directory or they describe different builds.

// `node:fs`/`node:path` because Bun ships neither: `dirname` walks a resolved module up to the
// directory that owns it, `basename` names the two segments the store layout is recognised by,
// and `existsSync` is what says which directory is really there.
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Deep enough for `src/index.ts` and for any entry an `exports` map could point at, shallow enough
 * that a resolver answering something unexpected stops rather than walking to `/`.
 */
const MAX_DEPTH = 6;

/** The two segments Bun's isolated layout is recognised by: `node_modules/.bun/<pkg>@<version>/`. */
const STORE_DIR = '.bun';
const NODE_MODULES = 'node_modules';

/**
 * `node_modules/.bun/@ultimat3+core@7.0.0/node_modules/@ultimat3` → `node_modules/@ultimat3`.
 *
 * Bun's **isolated** layout gives every package its own store entry, and a store entry's scope
 * directory holds exactly the one package it was created for. `Bun.resolveSync` follows the
 * install's symlink into that store, so walking up from the resolved entry lands there rather
 * than in the tree an app actually installed: measured on a fixture install, `x docs` saw
 * **1** of 6 packages, and `x errors explain` answered *"nothing in the installed framework raises
 * X_…"* — with `ok: true` — for 400 of 405 codes. A confident wrong answer, from a walk that had
 * never looked at the app's own `node_modules`.
 *
 * The store is recognised by its own shape and never by an app root handed in from outside: the
 * two callers here are a module-scope memo (`error-fixes.ts`) and a command that may run under
 * `--cwd`, so a cwd-derived root would be wrong for one of them and absent for the other.
 *
 * `undefined` — leaving the caller on the resolved answer — whenever this is not a store path or
 * the sibling scope directory is not there. A hoisted install already resolves to
 * `node_modules/@ultimat3/core` and a workspace checkout to `packages/core`, and neither has a
 * `.bun` above it.
 */
function installedScopeFor(storeScope: string): string | undefined {
  const scopeName = basename(storeScope);
  let dir = storeScope;
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    if (basename(dir) === STORE_DIR && basename(parent) === NODE_MODULES) {
      const candidate = join(parent, scopeName);
      return existsSync(candidate) ? candidate : undefined;
    }
    dir = parent;
  }
  return undefined;
}

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
 * Following the symlink is also what makes the last step necessary rather than optional: under
 * Bun's isolated layout the entry resolves *into the store*, whose scope directory holds one
 * package. `installedScopeFor` is the correction, and it is a shape test on the path — never a
 * `readdir` of the resolved package's parent, which is the read that reported one package as the
 * whole framework.
 *
 * `resolveFrom` exists so a test can point this at a fixture install; nothing passes it in
 * production, where the only defensible base is this module's own directory.
 *
 * `undefined` means the CLI cannot see its own dependency, which is a broken install and not
 * merely an undocumented one; every caller reports that rather than answering emptily.
 */
export function frameworkScopeDir(resolveFrom: string = import.meta.dir): string | undefined {
  let dir: string;
  try {
    dir = dirname(Bun.resolveSync('@ultimat3/core', resolveFrom));
  } catch {
    return undefined;
  }
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    if (existsSync(join(dir, 'package.json'))) {
      const scope = dirname(dir);
      return installedScopeFor(scope) ?? scope;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}
