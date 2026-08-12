/**
 * SCSS → CSS, plus the scoped class-name map every `import styles from './x.module.scss'` already
 * assumes exists. Scoping is content-addressed, so the same source compiles to the same class names
 * on every machine and the output diffs across deploys the way the HTML does.
 */

import { existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as sass from 'sass';
import { PrerenderFailedError } from './errors';
import { contentHash } from './render-static';

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
const packageImporter = (from: string): sass.FileImporter<'sync'> => ({
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
  const masked = css.replace(PROTECTED, (match) => {
    literals.push(match);
    return `${NUL}${literals.length - 1}${NUL}`;
  });
  const scoped = masked.replace(CLASS_SELECTOR, (_match, name: string) => {
    const local = `${name}_${suffix}`;
    classes[name] = local;
    return `.${local}`;
  });
  const restored = scoped.replace(
    MASKED,
    // The mask is dense and index-addressed, so a miss is impossible; `??` only keeps
    // `noUncheckedIndexedAccess` honest.
    (_match, index: string) => literals[Number(index)] ?? '',
  );
  return { css: restored, classes };
}

/** The fix line for a stylesheet that names tokens `@ultimat3/ui/tokens` does not export. */
const TOKEN_FIX =
  "@ultimat3/ui/tokens exports functions and mixins — space(4), radius(md), role('surface-raised'), " +
  'text(sm) — and no $variables';

export function compileStylesheet(file: string, source: string): CompiledStylesheet {
  let css: string;
  try {
    css = sass.compileString(source, {
      url: pathToFileURL(file),
      loadPaths: [dirname(file)],
      importers: [packageImporter(dirname(file))],
      style: 'compressed',
    }).css;
  } catch (error) {
    const first = error instanceof Error ? error.message.split('\n')[0] : String(error);
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
