// The stylesheet half of an island build: `import styles from './x.module.scss'` answers the class
// map the SERVER hashed, and the CSS lands in the same registry a document renders from. Bun's
// default loader answers the asset PATH — a string — so `styles['track']` is `undefined`, every
// element renders unclassed, and `Bun.build` reports `success: true` with no log.

// why: Bun ships no path API; the bundler names its inputs relative to the building process's cwd.
import { resolve } from 'node:path';
import { renderThrowable, UltimateError } from '@ultimat3/core';
import { compileStylesheet, loadStylesheet, registeredStylesheets } from '@ultimat3/render/server';
import type { BunPlugin } from 'bun';
import { IslandBuildFailedError } from './errors';

/**
 * The same spelling `installRenderLoader` filters on, so there is ONE answer to "what is a
 * stylesheet import" across the server loader and the island bundler. A plain `.css`/`.scss` is in
 * deliberately: it compiles to an empty class map and registers its rules, which is what a global
 * stylesheet an island imports has to do.
 */
const STYLESHEET = /\.s?css$/;

/** Whether `path` is a stylesheet by the one spelling the loader and the bundler share. */
export const isStylesheet = (path: string): boolean => STYLESHEET.test(path);

/**
 * Every stylesheet an island build has loaded in this process, absolute. `x build --target docker`
 * writes them into the island store, so a container that serves the stored chunks registers the
 * same sheets a build would have — and every pod of one image joins the same surface stylesheet.
 */
const islandSheets = new Set<string>();

/** Sorted, so the store index is byte-identical for identical input. */
export const islandStylesheets = (): readonly string[] => [...islandSheets].sort();

/** Registers one island stylesheet: what the plugin does on a load, and a cached group's hit. */
export function registerIslandStylesheet(path: string, source: string): string {
  islandSheets.add(path);
  return loadStylesheet(path, source, 'island');
}

/**
 * `loadStylesheet`, not `compileStylesheet`: compiling alone answers the class names and drops the
 * RULES on the floor, and an island is the one importer a document's own module graph never sees.
 * Registering here is what puts them in `stylesFor(surface)` — `buildIslands` runs before the first
 * document is rendered, in `x dev` and in `prerenderSite` alike.
 *
 * One plugin per `buildIslands` call, holding each sheet's answer for that call: every group's
 * build loads the design system's sheets again, and compiling them once per group was 6.0 s of a
 * 19.6 s build of the 159-island bench app (one CPU profile, As of 2026-11-10). Per call and never
 * per process, so a `x dev` rebuild compiles an edited sheet — or a partial it `@use`s — afresh.
 */
/** The plugin, and the Sass partials each sheet it loaded read — what a cache entry must rehash. */
export interface IslandStyles extends BunPlugin {
  dependenciesOf(sheets: readonly string[]): readonly string[];
}

export function islandStylesPlugin(): IslandStyles {
  const compiled = new Map<string, Promise<string>>();
  const partials = new Map<string, readonly string[]>();
  const load = async (path: string): Promise<string> => {
    const source = await Bun.file(path).text();
    try {
      const classes = registerIslandStylesheet(path, source);
      // A partial `@use`d by the sheet moves its class hashes and is no bundler input: read off the
      // registry the load just wrote, compiled again only for a sheet with no rules to register.
      const held = registeredStylesheets().find((sheet) => sheet.file === path);
      partials.set(path, held?.dependencies ?? compileStylesheet(path, source).dependencies);
      return classes;
    } catch (error) {
      // A coded failure already names the file and carries a fix — re-wrapping it would bury
      // both. Anything else is rendered through `renderThrowable`, because this is the plugin's
      // last frame and a value that fights being read would escape a Bun plugin as a bare throw.
      if (error instanceof UltimateError) throw error;
      throw new IslandBuildFailedError({ file: path, logs: renderThrowable(error) });
    }
  };
  return {
    name: 'ultimate-island-styles',
    dependenciesOf: (sheets) => [...new Set(sheets.flatMap((one) => partials.get(one) ?? []))],
    setup(build): void {
      build.onLoad({ filter: STYLESHEET }, async ({ path }) => {
        let contents = compiled.get(path);
        if (contents === undefined) {
          contents = load(path);
          compiled.set(path, contents);
        }
        return { contents: await contents, loader: 'js' };
      });
    },
  };
}

/**
 * The stylesheets among a build's metafile inputs (cwd-relative), absolute — a package's own
 * included, which a cached group must register again exactly as the build's plugin did.
 */
export function stylesheetsOf(inputs: readonly string[]): readonly string[] {
  const cwd = process.cwd();
  return [
    ...new Set(inputs.filter((one) => STYLESHEET.test(one)).map((one) => resolve(cwd, one))),
  ].sort();
}
