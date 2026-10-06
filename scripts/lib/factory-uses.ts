// Which files of an app USE a primitive factory: a static value import of it from its package,
// read as code, and a top-level export initialised by calling it. The scanner behind
// `primitive-factories-used.test.ts`, kept out of the test so the logic and its proof are separate.

/** `import { a, b as c } from '<pkg>'` — value imports only; `import type` names nothing callable. */
const NAMED_IMPORT = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*'([^']+)'/g;

/** The local name each named VALUE import of `pkg` binds in `source`, keyed by exported name. */
export function valueImportsOf(source: string, pkg: string): ReadonlyMap<string, string> {
  const bound = new Map<string, string>();
  for (const match of source.matchAll(NAMED_IMPORT)) {
    if (match[1] !== undefined || match[3] !== pkg) continue;
    for (const raw of (match[2] as string).split(',')) {
      const spec = raw.trim();
      if (spec === '' || spec.startsWith('type ')) continue;
      const [exported = '', local = exported] = spec.split(/\s+as\s+/).map((part) => part.trim());
      bound.set(exported, local);
    }
  }
  return bound;
}

/**
 * The source as CODE: every comment blanked, and every string and template literal's contents
 * blanked unless `keepStrings` — one left-to-right pass, so `'https://x'` is not a comment and a
 * `/*` inside a string opens nothing. Blanked with spaces, never removed, so lines stay where they
 * were. Prose saying `hive()` beside a declaration, a call spelled inside a string and a commented
 * import are all text a scan must not count (CodeRabbit on #684).
 */
export function codeOf(source: string, keepStrings = false): string {
  let out = '';
  let index = 0;
  const blank = (text: string): string => text.replace(/[^\n]/g, ' ');
  while (index < source.length) {
    const char = source[index] as string;
    const next = source[index + 1];
    if (char === '/' && (next === '/' || next === '*')) {
      const close = next === '/' ? source.indexOf('\n', index) : source.indexOf('*/', index + 2);
      const stop = close === -1 ? source.length : next === '/' ? close : close + 2;
      out += blank(source.slice(index, stop));
      index = stop;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      let stop = index + 1;
      while (stop < source.length && source[stop] !== char) stop += source[stop] === '\\' ? 2 : 1;
      const body = source.slice(index + 1, stop);
      out += char + (keepStrings ? body : blank(body)) + (source[stop] ?? '');
      index = stop + 1;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

/**
 * A file USES a factory when it imports it statically from its package — an import that is code,
 * not a comment — AND declares a top-level export initialised by calling it:
 * `export const summarizePosts = hive({ … })`. That shape is the whole point: a factory's result is
 * a primitive, registered under its export name by `defineApi`'s module scan, so a call that is
 * not an exported declaration — nested in a function, behind an `if (false)`, discarded — builds
 * nothing the app serves. A type position cannot hold a call, and `typeof hive` is not one.
 */
export function usesFactory(source: string, factory: string, pkg: string): boolean {
  const local = valueImportsOf(codeOf(source, true), pkg).get(factory);
  if (local === undefined) return false;
  const declared = new RegExp(
    `^export\\s+const\\s+[\\w$]+(?:\\s*:[^=]+)?\\s*=\\s*${local}\\s*\\(`,
    'm',
  );
  return declared.test(codeOf(source));
}
