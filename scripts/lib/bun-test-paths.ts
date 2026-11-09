// Read a `bun test …` invocation and name each positional that bun treats as a substring FILTER
// though it was written as a path. `bun test packages/core` at the repo root also runs
// `examples/dummy/packages/core/…` under the wrong config; `./packages/core/` is a path.

/** `bun test` flags whose value is the NEXT token, so that token is never a positional. */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-t',
  '--test-name-pattern',
  '--timeout',
  '--preload',
  '-r',
  '--rerun-each',
  '--reporter',
  '--reporter-outfile',
  '--coverage-dir',
  '--coverage-reporter',
  '--seed',
  '--max-concurrency',
]);

/** A token that ends the command: what follows belongs to another command or is a comment. */
const SEPARATOR = /^(?:;|&&|\|\||\||#.*|\))$/;

const unquote = (token: string): string => token.replace(/^['"]|['"]$/g, '');

/**
 * A spelling bun reads as a path rather than a filter: anchored, or not path-shaped at all. A
 * LEADING placeholder (`<path>/x.test.ts`) is the reader's to fill, `./` included, so it is not
 * judged; `packages/<pkg>` fixes the root and is.
 */
const isPathOrName = (arg: string): boolean =>
  !arg.includes('/') || /^(?:\.{1,2}\/|\/|~|\$|<)/.test(arg);

/** Split on whitespace, peeling a trailing `;` off a token so `a/b;` ends the command. */
function tokens(text: string): readonly string[] {
  return text
    .split(/\s+/)
    .filter((token) => token !== '')
    .flatMap((token) =>
      token.length > 1 && token.endsWith(';') ? [token.slice(0, -1), ';'] : [token],
    );
}

/** Every bare path-shaped positional of every `bun test` in one span, in order. */
export function bareTestPaths(span: string): readonly string[] {
  const words = tokens(span);
  const found: string[] = [];
  for (let start = 0; start < words.length - 1; start += 1) {
    if (words[start] !== 'bun' || words[start + 1] !== 'test') continue;
    for (let index = start + 2; index < words.length; index += 1) {
      const word = words[index] ?? '';
      if (SEPARATOR.test(word) || word.startsWith('#')) break;
      if (word.startsWith('-')) {
        if (!word.includes('=') && VALUE_FLAGS.has(word)) index += 1;
        continue;
      }
      const arg = unquote(word);
      if (!isPathOrName(arg)) found.push(arg);
    }
  }
  return found;
}
