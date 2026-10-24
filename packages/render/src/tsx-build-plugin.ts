/**
 * The server `.tsx` transform as a `Bun.build` plugin: what a bundle that carries server code —
 * the compiled `x` executable, a module-graph measurement — hands the bundler so a `.tsx` it
 * reaches compiles to the server factory, the same output the runtime loader gives that file.
 */

import type { BunPlugin } from 'bun';
import { JSX_FACTORY_SPECIFIER, transformTsx } from './module-loader';

/**
 * The PATH the loader's resolved URL names. `Bun.build` does not resolve a `file:` specifier —
 * measured on 1.4.3, `Could not resolve: "file:///…/packages/render/src/index.ts"` — and resolves an
 * absolute path. The bare-name fallback (inside a compiled binary) passes through unchanged.
 */
const BUILD_FACTORY_SPECIFIER = JSX_FACTORY_SPECIFIER.startsWith('file:')
  ? Bun.fileURLToPath(JSX_FACTORY_SPECIFIER)
  : JSX_FACTORY_SPECIFIER;

/**
 * Without it a bundle compiles each `.tsx` with Bun's own transform, which no Bun gets right
 * (`module-loader.ts`): 1.4.3 refuses the build outright with `No matching export in
 * "solid-js/dist/solid.js" for import "jsxDEV"` (issue #883), and earlier Bun shipped a
 * `React.createElement` nobody defines. Islands do not use this: their graph is a browser's, and
 * `@ultimat3/cli`'s `solidJsxPlugin` compiles it with Solid.
 */
export const serverTsxBuildPlugin: BunPlugin = {
  name: 'ultimate-render-tsx',
  setup(build): void {
    build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => ({
      contents: transformTsx(await Bun.file(path).text(), BUILD_FACTORY_SPECIFIER),
      loader: 'js',
    }));
  },
};
