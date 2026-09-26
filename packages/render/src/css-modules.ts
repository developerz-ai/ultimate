/**
 * SCSS → CSS, plus the scoped class-name map every `import styles from './x.module.scss'` already
 * assumes exists. Scoping is content-addressed, so the same source compiles to the same class names
 * on every machine and the output diffs across deploys the way the HTML does.
 */

import { existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderThrowable } from '@ultimat3/core';
import type * as Sass from 'sass';
import { PrerenderFailedError } from './errors';
import { contentHash } from './render-static';
import { cachedSassCompile } from './sass-cache';

export interface CompiledStylesheet {
  readonly css: string;
  /** `hero` → `hero_1f2e3d4c`. Empty for a plain (non-module) stylesheet. */
  readonly classes: Readonly<Record<string, string>>;
}

/** A file is a CSS module when its name says so — one spelling, per the `.module.scss` convention. */
export function isCssModule(file: string): boolean {
  return file.endsWith('.module.scss') || file.endsWith('.module.css');
}

/**
 * The complement, named rather than spelled `!isCssModule(…)` at the call site, because the
 * registry ORDERS on it: a plain stylesheet is the global layer — the `:root` custom properties
 * every module rule reads through `var(--…)`, and the element reset — and it has to reach the
 * document before the modules do. A cascade rule that only exists as a negation at one call site
 * is a cascade rule the next reader inverts by accident.
 */
export function isGlobalStylesheet(file: string): boolean {
  return !isCssModule(file);
}

/**
 * Sass resolves relative `@use` itself; a bare specifier is Bun's job, because `@ultimat3/ui/tokens`
 * is an `exports` entry and only the module resolver knows where that lands.
 */
const packageImporter = (from: string): Sass.FileImporter<'sync'> => ({
  findFileUrl(url: string, context: { readonly containingUrl?: URL | null }): URL | null {
    // Sass routes every load inside a file THIS importer supplied back to this importer, including
    // `_index.scss`'s own relative `@forward`s — so the filesystem lookup has to live here too, or
    // a package entry point resolves and every partial it forwards does not.
    const base =
      context.containingUrl === undefined || context.containingUrl === null
        ? from
        : dirname(fileURLToPath(context.containingUrl));
    const local = partialCandidates(resolve(base, url)).find((candidate) => existsSync(candidate));
    if (local !== undefined) return pathToFileURL(local);
    try {
      return pathToFileURL(Bun.resolveSync(url, base));
    } catch {
      return null;
    }
  },
});

/** Sass's own load order for a bare name: the file, its partial, then the directory's index. */
const partialCandidates = (target: string): readonly string[] => {
  const dir = dirname(target);
  const name = basename(target);
  return [
    `${dir}/${name}.scss`,
    `${dir}/_${name}.scss`,
    `${target}/_index.scss`,
    `${target}/index.scss`,
    `${dir}/${name}.css`,
  ];
};

/** Strings and `url()` payloads may contain a `.` that is not a class selector. */
const PROTECTED = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|url\([^)]*\)/g;
/** A class selector: a dot followed by an identifier start. `0.5rem` cannot match — `5` is not one. */
const CLASS_SELECTOR = /\.(-?[A-Za-z_][\w-]*)/g;
/**
 * The mask delimiter. NUL is the one byte CSS cannot contain, so the restore pass cannot mistake
 * a real declaration for a placeholder — a bare numeric marker would collide with `flex:1 1 0`.
 */
const NUL = '\u0000';
const MASKED = new RegExp(`${NUL}(\\d+)${NUL}`, 'g');

const GLOBAL_OPEN = ':global(';

/**
 * Unwrap every `:global(<selector>)` to `<selector>`, handing each payload to `keep` so the class
 * rewrite that follows cannot touch it. `:global()` is CSS-MODULES syntax, not CSS: emitted as
 * written it is an unknown pseudo-class, and a browser drops the whole rule. `Table.module.scss`
 * shipped twelve such rules, so the catalog table reached every app with no cell padding, no row
 * borders and no header ground — invisible to every test, because the CSS was never parsed by
 * anything but a browser.
 *
 * A scanner rather than a regex: the payload is a selector and may hold its own parentheses
 * (`tr:nth-child(even)`), so the wrapper closes on ITS parenthesis, found by depth. An unclosed
 * wrapper is left exactly as written — swallowing the rest of the sheet to "repair" a typo would
 * turn one broken rule into every rule after it.
 */
function unwrapGlobal(css: string, keep: (selector: string) => string): string {
  let out = '';
  let cursor = 0;
  for (;;) {
    const open = css.indexOf(GLOBAL_OPEN, cursor);
    if (open === -1) return out + css.slice(cursor);
    const start = open + GLOBAL_OPEN.length;
    let depth = 1;
    let end = start;
    while (end < css.length && depth > 0) {
      const char = css[end];
      // A `{` means the selector list ended with the wrapper still open: not ours to repair.
      if (char === '{') break;
      if (char === '(') depth += 1;
      else if (char === ')') depth -= 1;
      end += 1;
    }
    if (depth !== 0) return out + css.slice(cursor);
    // The payload is unwrapped FIRST, so `:global(:global(.x))` yields `.x` — a wrapper left inside
    // the mask would be restored verbatim, and the browser would drop the rule after all.
    out +=
      css.slice(cursor, open) + keep(unwrapGlobal(css.slice(start, end - 1), (inner) => inner));
    cursor = end;
  }
}

/**
 * Rewrite every class selector to its scoped name and report the map. Done on the compiled CSS
 * rather than the SCSS source so mixins, `@extend` and interpolation have already produced their
 * final selectors — a rewrite before Sass runs would miss every class a mixin generates.
 */
export function scopeClasses(
  css: string,
  suffix: string,
): { readonly css: string; readonly classes: Record<string, string> } {
  const classes: Record<string, string> = {};
  const literals: string[] = [];
  const mask = (match: string): string => {
    literals.push(match);
    return `${NUL}${literals.length - 1}${NUL}`;
  };
  // Strings and `url()` first, so a `:global(` inside a `content:` string is never unwrapped;
  // then each `:global()` payload joins the same mask and comes back unscoped.
  const masked = unwrapGlobal(css.replace(PROTECTED, mask), mask);
  const scoped = masked.replace(CLASS_SELECTOR, (_match, name: string) => {
    const local = `${name}_${suffix}`;
    classes[name] = local;
    return `.${local}`;
  });
  // Recursive: a `:global()` payload is masked AFTER the strings inside it were, so its literal
  // holds their placeholders — one pass restored `html[data-theme='light']` as
  // `html[data-theme=\0 0 \0]`, a selector that matched nothing. A literal only ever holds
  // placeholders with LOWER indexes than its own, so the recursion ends.
  const restore = (text: string): string =>
    text.replace(
      MASKED,
      // The mask is dense and index-addressed, so a miss is impossible; `??` only keeps
      // `noUncheckedIndexedAccess` honest.
      (_match, index: string) => restore(literals[Number(index)] ?? ''),
    );
  return { css: restore(scoped), classes };
}

/** The fix line for a stylesheet that names tokens `@ultimat3/ui/tokens` does not export. */
const TOKEN_FIX =
  "@ultimat3/ui/tokens exports functions and mixins — space(4), radius(md), role('surface-raised'), " +
  'text(sm) — and no $variables';

/**
 * A leading byte-order mark or `@charset` rule: the encoding claim Sass writes at the head of any
 * output holding a non-ASCII character. Anchored to the START — a `@charset` anywhere else is
 * already invalid CSS and not this function's to repair.
 */
const CHARSET_HEAD = /^\uFEFF?(?:@charset\s+"[^"]*"\s*;\s*)?/u;

/**
 * Drop the encoding claim from the head of one compiled sheet. Sass emits it for the FILE it
 * believes it is writing, and it is right about a file: a stylesheet that begins with U+FEFF is
 * decoded as UTF-8 by every browser. It is wrong about a fragment. The registry concatenates
 * modules verbatim, so every module after the first that holds a `content: '·'` began with a BOM
 * glued to its first selector — `\uFEFF.dashboard_256ee8e0{display:grid}` — which the browser reads
 * as an unparseable selector and drops with its whole rule. Measured on ai-maxxing's home
 * stylesheet, 2026-09-06: seven modules, seven first rules gone, the dashboard's grid container
 * painting `display: block` with only the UA rule in Chrome's matched styles. The bundle is served
 * `text/css; charset=utf-8` by the route, so no sheet needs to claim its encoding at all.
 *
 * Applied at BOTH seams: on the compile, where `charset: false` already asks Sass not to write it,
 * and again where the sheets are joined, so a future Sass that ignores the option — or a sheet
 * that reached the registry by another road — still cannot put a BOM mid-file.
 */
export function stripCharset(css: string): string {
  return css.replace(CHARSET_HEAD, '');
}

let loadedSass: typeof Sass | undefined;

/**
 * Dart Sass, loaded on the first compile and never at import: it is ~290ms of module evaluation,
 * measured, and every process importing `@ultimat3/render/server` paid it — `x --help`, `x doctor`,
 * a container role that renders no stylesheet. `require` and not `import()` because this function
 * is synchronous: Bun's loader-plugin `onLoad` path in `module-loader.ts` calls it inline.
 */
const sassCompiler = (): typeof Sass => {
  loadedSass ??= require('sass') as typeof Sass;
  return loadedSass;
};

/** Changes whenever the `compileString` options below do, so a cached entry never outlives them. */
const COMPILE_OPTIONS = 'v1 compressed charset:false loadPaths:dirname importer:package';

let loadedVersion: string | undefined;

/** `sass`'s own version, without evaluating `sass` — the cache key needs it before any compile. */
const sassVersion = (): string => {
  loadedVersion ??= String(
    (require('sass/package.json') as { readonly version?: unknown }).version ?? 'unknown',
  );
  return loadedVersion;
};

export function compileStylesheet(file: string, source: string): CompiledStylesheet {
  let css: string;
  try {
    // Everything that is not a loaded file goes in the key: the compiler, the options below (named
    // by `COMPILE_OPTIONS`), the path the relative `@use`s resolve from, and the source itself. The
    // version is read from Sass's package.json, so a run whose every sheet hits never loads Sass.
    const key = `${sassVersion()}\0${COMPILE_OPTIONS}\0${file}\0${source}`;
    css = stripCharset(
      cachedSassCompile(key, () => {
        const result = sassCompiler().compileString(source, {
          url: pathToFileURL(file),
          loadPaths: [dirname(file)],
          importers: [packageImporter(dirname(file))],
          style: 'compressed',
          // No `@charset`, no BOM — see `stripCharset`. Dart Sass writes one for any compressed
          // output holding a non-ASCII character, and re-emits an escaped `\\00b7` as the literal
          // character, so escaping in the app cannot avoid it.
          charset: false,
        });
        return {
          css: result.css,
          loaded: result.loadedUrls.map((loaded) =>
            loaded.protocol === 'file:' ? fileURLToPath(loaded) : undefined,
          ),
        };
      }),
    );
  } catch (error) {
    // `renderThrowable`, never `.message`/`String()`: an importer, a plugin or a future Sass
    // release can throw a value whose own read raises, and this frame is what turns a failed
    // compile into `X_PRERENDER_FAILED` naming the file — a laundered read leaves it a bare one.
    const first = renderThrowable(error).split('\n')[0];
    throw new PrerenderFailedError(
      `${file} did not compile: ${first}`,
      `edit ${file}: ${TOKEN_FIX}`,
    );
  }
  if (!isCssModule(file)) return { css, classes: {} };
  // Content-addressed, not path-addressed: a checkout at a different absolute path must produce
  // byte-identical CSS, which a hash over the absolute filename would not.
  const scoped = scopeClasses(css, contentHash(`${file.split('/').pop() ?? file} ${source}`));
  return { css: scoped.css, classes: scoped.classes };
}
