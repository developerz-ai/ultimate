/**
 * The two loaders that make an app's source runnable: `.tsx` → the server JSX factory, and
 * `.scss` → CSS plus a class-name map. Both are Bun runtime plugins, so `x dev`, `x build` and
 * `bun test` all load a component the same way and there is no separate "bundled" behaviour.
 */

import { renderThrowable } from '@ultimat3/core';
import { compileStylesheet, isGlobalStylesheet } from './css-modules';
import { PrerenderFailedError } from './errors';
import type { Surface } from './surfaces';
import { surfaceOf } from './surfaces';

/**
 * Why a transform at all: `tsconfig.json` says `jsx: 'preserve'`, which makes Bun fall back to the
 * CLASSIC React factory and ignore `jsxImportSource` entirely — every `.tsx` in an Ultimate app
 * compiles to `React.createElement` against a global that does not exist. `jsxImportSource` stays
 * pointed at `solid-js` because that is where the JSX *type* namespace lives (`class`, not
 * `className`); the *runtime* factory is the framework's, and an app never configures one.
 */
const JSX_FACTORY = '__xh';
const JSX_FRAGMENT = '__xFragment';

/** No newline: the prelude shares line 1 with the file's own first line, so stack traces still point at it. */
const JSX_PRELUDE = `import { h as ${JSX_FACTORY}, Fragment as ${JSX_FRAGMENT} } from '@ultimat3/render';`;

const transpiler = new Bun.Transpiler({
  loader: 'tsx',
  tsconfig: {
    compilerOptions: {
      jsx: 'react',
      jsxFactory: JSX_FACTORY,
      jsxFragmentFactory: JSX_FRAGMENT,
    },
  } as never,
});

export interface Stylesheet {
  /** Absolute path of the source file. */
  readonly file: string;
  /** The surface that owns it, or `null` for a package stylesheet shared by both graphs. */
  readonly surface: Surface | null;
  /** A plain (non-module) stylesheet: the tokens and the reset, which the cascade needs first. */
  readonly global: boolean;
  readonly css: string;
}

const stylesheets = new Map<string, Stylesheet>();

export function registeredStylesheets(): readonly Stylesheet[] {
  return [...stylesheets.values()];
}

/** Test seam: the registry is process-global because the module cache it mirrors is too. */
export function clearStylesheets(): void {
  stylesheets.clear();
}

/**
 * The CSS a document on `surface` must carry: the global layer first, then the modules, each group
 * in load order. A `site/` page never receives `app/` CSS — that is axiom 6 applied to bytes the
 * browser parses, not just bytes it executes.
 *
 * `shared/` is carried by both graphs by definition — it is the one directory both surfaces import
 * from, and it is where an app's own global stylesheet lives. Filtering it out (which this did)
 * meant an app could put its tokens in the one place the convention names and have every document
 * silently drop them.
 *
 * Globals sort ahead of modules rather than riding load order: the reset styles bare elements at
 * the lowest specificity there is, so a reset that happened to register after a module rule wins
 * ties it must lose. Insertion order alone made that depend on which page a request hit first.
 */
export function stylesFor(surface: Surface | null): string {
  const carried = [...stylesheets.values()].filter(
    (sheet) => sheet.surface === null || sheet.surface === 'shared' || sheet.surface === surface,
  );
  return [...carried.filter((sheet) => sheet.global), ...carried.filter((sheet) => !sheet.global)]
    .map((sheet) => sheet.css)
    .join('');
}

/**
 * `.tsx` source → JS calling the server factory. Exported so the transform is testable as a pure
 * function: the plugin below is the six lines of glue that hand it a file.
 */
export function transformTsx(source: string): string {
  // No newline between: the prelude shares line 1 with the file's own first line, so every stack
  // trace and every reported error still points at the line the author wrote.
  return JSX_PRELUDE + transpiler.transformSync(source);
}

/**
 * `.scss` source → the module body an `import styles from …` receives, registering the CSS.
 *
 * Keyed by absolute path, which is what makes the global layer emit ONCE however many app modules
 * import it. Sass dedupes `@use` within a single compilation, and every file here is its own
 * compilation — so a token file `@use`d by twenty `page.module.scss` would inline its `:root` block
 * twenty times. One file, imported for its side effect, is the shape that cannot do that.
 */
export function loadStylesheet(path: string, source: string): string {
  const compiled = compileStylesheet(path, source);
  if (compiled.css.length > 0) {
    stylesheets.set(path, {
      file: path,
      surface: surfaceOf(path),
      global: isGlobalStylesheet(path),
      css: compiled.css,
    });
  }
  return `export default ${JSON.stringify(compiled.classes)};`;
}

let installed = false;

/**
 * Idempotent: importing `@ultimat3/render` from anywhere installs it once, which is the only
 * placement that covers `x dev`, `x build`, the production `server.ts` and `bun test` without each
 * of them remembering to. A plugin only affects modules loaded AFTER it, and every route module is.
 */
export function installRenderLoader(): void {
  if (installed) return;
  installed = true;

  Bun.plugin({
    name: 'ultimate-render',
    setup(build): void {
      build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => ({
        contents: transformTsx(await Bun.file(path).text()),
        loader: 'js',
      }));

      build.onLoad({ filter: /\.(?:s?css)$/ }, async ({ path }) => {
        const source = await Bun.file(path).text();
        try {
          return { contents: loadStylesheet(path, source), loader: 'js' };
        } catch (error) {
          if (error instanceof PrerenderFailedError) throw error;
          throw new PrerenderFailedError(
            // `renderThrowable` from core, never `.message`/`String()`: this catch is the loader's
            // last frame, and a value that fights being read would replace the coded failure with
            // a bare throw out of a Bun plugin — where no route and no file name survives.
            `${path} could not be loaded: ${renderThrowable(error)}`,
            `open ${path} and fix the stylesheet it @use-s`,
          );
        }
      });
    },
  });
}
