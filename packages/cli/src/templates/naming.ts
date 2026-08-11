// Name derivation for generators. One place, because `x g resource post` has to agree with itself
// across eight emitted files — a second casing helper is how `Post`/`post`/`posts` drift apart.

/**
 * A catalog is one file per locale that many generators contribute keys to; a whole-file write
 * would delete every key already in it, so a `'json'` file merges instead of overwriting. Always
 * text: `cmd-generate.ts`'s `dedupe`/`mergeJsonFile` parse and merge `contents` as a JSON object,
 * a step that only ever runs against this variant.
 */
export interface GeneratedJsonFile {
  /** POSIX path relative to the app root. */
  readonly path: string;
  readonly contents: string;
  readonly merge: 'json';
}

/**
 * Every other generated file. Text in almost every case, but the scaffolded app icon is bytes,
 * not prose: a PNG cannot survive a UTF-8 string round-trip (every byte above 0x7F comes back
 * mangled), so `contents` has to admit raw bytes too — `Bun.write` already accepts either, so
 * nothing downstream needs a second write path.
 */
export interface GeneratedSourceFile {
  /** POSIX path relative to the app root. */
  readonly path: string;
  readonly contents: string | Uint8Array;
  readonly merge?: undefined;
}

/**
 * Split on `merge` rather than widening one shape's `contents` in place, so the split is
 * load-bearing, not cosmetic: a `merge: 'json'` file's `contents` stays a plain `string` at the
 * type level, which is what stops a byte-carrying file from ever reaching
 * `cmd-generate.ts`'s JSON parser — the compiler refuses the call before the code can run.
 */
export type GeneratedFile = GeneratedJsonFile | GeneratedSourceFile;

const words = (input: string): readonly string[] =>
  input
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.toLowerCase());

export const kebab = (input: string): string => words(input).join('-');

export const camel = (input: string): string =>
  words(input)
    .map((word, index) => (index === 0 ? word : `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`))
    .join('');

export const pascal = (input: string): string => {
  const value = camel(input);
  return (value[0]?.toUpperCase() ?? '') + value.slice(1);
};

/** Deliberately naive: English -s/-es/-ies. A generator name is one word in practice. */
export const plural = (input: string): string => {
  if (/(s|x|z|ch|sh)$/.test(input)) return `${input}es`;
  if (/[^aeiou]y$/.test(input)) return `${input.slice(0, -1)}ies`;
  return `${input}s`;
};

export const titleKey = (input: string): string => `app.${kebab(input)}.title`;

export interface NameSet {
  readonly raw: string;
  readonly kebab: string;
  readonly camel: string;
  readonly pascal: string;
  readonly plural: string;
  readonly pluralKebab: string;
  /** Singular snake_case. Constraint and index names. */
  readonly snake: string;
  /**
   * The table identifier: plural snake_case. Derived here rather than at each call site because
   * the entity, the repo SQL, the query source and the mutator's local table all name the same
   * table — and Postgres lowercases every unquoted identifier, so a hyphen would have to be
   * quoted forever.
   */
  readonly table: string;
}

export function names(input: string): NameSet {
  const base = camel(input);
  const pluralKebab = kebab(plural(base));
  return {
    raw: input,
    kebab: kebab(input),
    camel: base,
    pascal: pascal(input),
    plural: plural(base),
    pluralKebab,
    snake: kebab(input).split('-').join('_'),
    table: pluralKebab.split('-').join('_'),
  };
}
