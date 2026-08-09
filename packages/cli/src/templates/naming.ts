// Name derivation for generators. One place, because `x g resource post` has to agree with itself
// across eight emitted files — a second casing helper is how `Post`/`post`/`posts` drift apart.

export interface GeneratedFile {
  /** POSIX path relative to the app root. */
  readonly path: string;
  readonly contents: string;
}

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
