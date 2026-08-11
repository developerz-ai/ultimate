/**
 * The two loaders that make an app's source runnable: `.tsx` → the server JSX factory, and
 * `.scss` → CSS plus a class-name map. Both are Bun runtime plugins, so `x dev`, `x build` and
 * `bun test` all load a component the same way and there is no separate "bundled" behaviour.
 */

import { compileStylesheet } from './css-modules';
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
 * The CSS a document on `surface` must carry, in load order. A `site/` page never receives `app/`
 * CSS — that is axiom 6 applied to bytes the browser parses, not just bytes it executes.
 */
export function stylesFor(surface: Surface | null): string {
  return [...stylesheets.values()]
    .filter((sheet) => sheet.surface === null || sheet.surface === surface)
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

/** `.scss` source → the module body an `import styles from …` receives, registering the CSS. */
export function loadStylesheet(path: string, source: string): string {
  const compiled = compileStylesheet(path, source);
  if (compiled.css.length > 0) {
    stylesheets.set(path, { file: path, surface: surfaceOf(path), css: compiled.css });
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
            `${path} could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
            `open ${path} and fix the stylesheet it @use-s`,
          );
        }
      });
    },
  });
}
