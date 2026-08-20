// The JSX transform every island chunk is built with: `.tsx` → Solid's COMPILED DOM output, run by
// `babel-preset-solid` inside the island `Bun.build`'s own plugin. Solid's reactivity is a
// COMPILE-time contract, which is why no runtime factory can stand in for the compiler here.

/// <reference path="../types/babel-modules.d.ts" />
// The reference is load-bearing, not decorative: @ultimat3/cli ships SOURCE, so an APP's
// `tsc` compiles this file inside ITS program, where a `.d.ts` sitting in this directory is
// not included and its `declare module` never applies. `tsc -b` proves it in this repo.
import { transformAsync } from '@babel/core';
import { contentHash } from '@ultimat3/render';
import solidPreset from 'babel-preset-solid';
import type { BunPlugin } from 'bun';
import { IslandBuildFailedError } from './errors';

/**
 * `generate: 'dom'` because an island runs in a browser and nowhere else; `hydratable: false`
 * because an island MOUNTS over server markup through its own `mount(el, props)` rather than
 * resuming a Solid hydration tree — there is no `renderToString` pass on the other side of it, so
 * hydration markers would be per-node bytes with no reader.
 */
const PRESET_OPTIONS = { generate: 'dom', hydratable: false } as const;

/**
 * The parser plugins, given DIRECTLY rather than through `@babel/plugin-syntax-typescript`. That
 * plugin does nothing but push this same array, and Babel 8 deleted its `isTSX` option — so the
 * documented spelling silently stops parsing JSX and every `<` becomes a type parameter. Given
 * here the option surface is Babel's parser, which has never moved.
 *
 * Order is inert here and is NOT inert via `plugins:` — as plugin entries, the JSX one must precede
 * the TypeScript one or `<button` parses as a type-parameter list. One more reason to say it once,
 * here.
 */
const PARSER_PLUGINS = ['typescript', 'jsx'] as const;

interface CacheEntry {
  /** `contentHash` of the source the code was compiled from. */
  readonly hash: string;
  readonly code: string;
}

/**
 * Keyed by PATH, not by content hash: `x dev` re-runs `buildIslands` on every change, and a map
 * keyed by content would grow one entry per keystroke for the life of the process. One entry per
 * island file is bounded by the island count, which is the only quantity that should bound it.
 *
 * It never hits inside a single `x build` — `discoverIslands` yields unique paths and `buildOne`
 * runs once each. The dev loop is the whole reason it exists: Babel is ~8.7ms a file against
 * `Bun.Transpiler`'s 0.07ms, so an app with twenty islands re-compiles nineteen unchanged files on
 * every rebuild without this.
 */
const cache = new Map<string, CacheEntry>();

/** Test seam: the cache is process-global because the dev server it serves is too. */
export function clearIslandTransformCache(): void {
  cache.clear();
}

/**
 * `.tsx` source → Solid's compiled DOM expressions. Exported so the transform is testable as a
 * function of its two inputs: the plugin below is the four lines of glue that hand it a file.
 *
 * The output is still TypeScript — Babel PARSES the annotations here and does not strip them,
 * which is why the plugin declares `loader: 'ts'` and lets Bun remove them.
 */
export async function transformIslandTsx(source: string, path: string): Promise<string> {
  const hash = contentHash(source);
  const hit = cache.get(path);
  if (hit !== undefined && hit.hash === hash) return hit.code;

  // Babel installs its own `prepareStackTrace` on the first TRANSFORM — not on import, which is
  // where this guard was first put — and leaving it installed makes `Error.captureStackTrace`
  // strict for every unrelated module loaded later in the same process.
  const saved = Error.prepareStackTrace;
  let code: string | null | undefined;
  try {
    // `transformAsync` and never `transformFileAsync`: the latter is gated behind `@babel/core`'s
    // `browser` export condition and throws "Transforming files is not supported in browsers"
    // under `bun --conditions=browser`, which is the condition Solid work runs in.
    const result = await transformAsync(source, {
      filename: path,
      // The app's own Babel config is not this transform's business, and an app that happens to
      // have one must not change what its islands compile to.
      babelrc: false,
      configFile: false,
      parserOpts: { plugins: [...PARSER_PLUGINS] },
      presets: [[solidPreset, PRESET_OPTIONS]],
    });
    code = result?.code;
  } finally {
    Error.prepareStackTrace = saved;
  }
  // A parse error is NOT caught here: Babel's own message already names the file, the line and the
  // column ("a.island.tsx: Unexpected token (2:23)"), and `buildOne` wraps whatever escapes in
  // `X_BUILD_FAILED` naming the island. Re-wrapping it here would only bury that.
  if (code == null) {
    throw new IslandBuildFailedError({
      file: path,
      logs: 'the Solid JSX transform emitted no code',
    });
  }
  cache.set(path, { hash, code });
  return code;
}

/**
 * The plugin `island-bundle.ts` hands `Bun.build`. It carries no state of its own, so one frozen
 * descriptor serves every concurrent island build — `Bun.build` calls `setup` once per build with
 * that build's own builder.
 *
 * `.tsx`, NOT `.island.tsx`. The narrow filter looks like axiom 6 and is the opposite of it: an
 * island that imports a plain `.tsx` component — the most ordinary thing an author does, and what
 * `x g resource` generates — would have that component compiled by nobody, and the app's
 * `jsx: "preserve"` tsconfig turns it straight back into `React.createElement("span", …)` and
 * `React is not defined`. Axiom 6 is already satisfied by GRAPH SEPARATION: this plugin runs
 * inside the island build, whose graph only ever holds islands and what they import, and a page
 * names its island by SPECIFIER and never imports one. So `.tsx` here already means exactly the
 * set that ships to a browser — the filter never had to do that work.
 */
export const solidJsxPlugin: BunPlugin = {
  name: 'ultimate-island-solid',
  setup(build): void {
    build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => ({
      contents: await transformIslandTsx(await Bun.file(path).text(), path),
      loader: 'ts',
    }));
  },
};
