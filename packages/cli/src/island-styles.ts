// The stylesheet half of an island build: `import styles from './x.module.scss'` answers the class
// map the SERVER hashed, and the CSS lands in the same registry a document renders from. Bun's
// default loader answers the asset PATH — a string — so `styles['track']` is `undefined`, every
// element renders unclassed, and `Bun.build` reports `success: true` with no log.

import { renderThrowable, UltimateError } from '@ultimat3/core';
import { loadStylesheet } from '@ultimat3/render/server';
import type { BunPlugin } from 'bun';
import { IslandBuildFailedError } from './errors';

/**
 * The same spelling `installRenderLoader` filters on, so there is ONE answer to "what is a
 * stylesheet import" across the server loader and the island bundler. A plain `.css`/`.scss` is in
 * deliberately: it compiles to an empty class map and registers its rules, which is what a global
 * stylesheet an island imports has to do.
 */
const STYLESHEET = /\.s?css$/;

/**
 * `loadStylesheet`, not `compileStylesheet`: compiling alone answers the class names and drops the
 * RULES on the floor, and an island is the one importer a document's own module graph never sees.
 * Registering here is what puts them in `stylesFor(surface)` — `buildIslands` runs before the first
 * document is rendered, in `x dev` and in `prerenderSite` alike.
 */
export const islandStylesPlugin: BunPlugin = {
  name: 'ultimate-island-styles',
  setup(build): void {
    build.onLoad({ filter: STYLESHEET }, async ({ path }) => {
      const source = await Bun.file(path).text();
      try {
        return { contents: loadStylesheet(path, source), loader: 'js' };
      } catch (error) {
        // A coded failure already names the file and carries a fix — re-wrapping it would bury
        // both. Anything else is rendered through `renderThrowable`, because this is the plugin's
        // last frame and a value that fights being read would escape a Bun plugin as a bare throw.
        if (error instanceof UltimateError) throw error;
        throw new IslandBuildFailedError({ file: path, logs: renderThrowable(error) });
      }
    });
  },
};
