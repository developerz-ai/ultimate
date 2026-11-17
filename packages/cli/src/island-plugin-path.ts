// The one way an island plugin answers `onResolve` with a file on disk: the path itself where
// `Bun.build` takes it, and a one-line re-export of it where `Bun.build` refuses the path.

import type { OnResolveResult, PluginBuilder } from 'bun';

/** Where a refused path is served from; the prefix keeps the re-export from resolving to itself. */
const NAMESPACE = 'ultimate-file';
const PREFIX = 'file:';

/**
 * why: Bun 1.4.4's `Bun.build` throws `onResolve plugin "path" must be absolute when the namespace
 * is "file"` for ANY returned path holding the substring `..` — not only a `..` segment
 * `path.normalize` would fold: `/a+..+b/m.js`, `/b..c/m.js` and `/d../m.js` are refused alike,
 * realpath or not (measured 2026-11-16, a one-plugin probe). Bun's isolated store names a `file:`
 * install `node_modules/.bun/@ultimat3+realtime@file+..+..+…/`, so a realtime resolved there
 * could not be handed back. Bun's OWN resolver takes such a path as an import specifier, so the
 * refused path is served as `export * from '<path>'`: the file still loads under its own path
 * string — the module key every relative import inside it gets — so nothing ships twice. Every
 * other path is answered as before, so a build that never meets `..` emits the same bytes.
 */
export function fileResult(path: string): OnResolveResult {
  return path.includes('..') ? { path: `${PREFIX}${path}`, namespace: NAMESPACE } : { path };
}

/**
 * The loader `fileResult`'s refused paths need, set up by every plugin that calls it. `export *`
 * carries every name but `default`, and each module these plugins resolve exports named bindings
 * only (the repo's rule: no default exports).
 */
export function serveRefusedPaths(build: PluginBuilder): void {
  build.onLoad({ filter: /.*/, namespace: NAMESPACE }, (args) => ({
    contents: `export * from ${JSON.stringify(args.path.slice(PREFIX.length))};\n`,
    loader: 'js',
  }));
}
