// Single responsibility: finding the end of ONE call in TypeScript source, and splitting what is
// inside it on its top-level commas. String, template, comment and REGEX runs are skipped, so a
// `(`, a `)` or a `,` inside one never moves the depth. One walker, for every rule that has to read
// a call — it lived twice, in `index-of-order.ts` and `sql-literal-copies.ts`, and the weaker copy
// was string-blind: `.replace(new RegExp("(", 'g'), "''")` miscounted and the site was dropped.

/** What may sit in front of a `/` that OPENS a regex. A value cannot, because then it is division. */
const REGEX_PRECEDERS = new Set([
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  '}',
  ';',
  '+',
  '-',
  '*',
  '%',
  '^',
  '~',
  '<',
  '>',
  undefined,
]);

/** The `/` closing the regex opened at `index`, past its flags — or `-1` when it never closes. */
const regexEnd = (src: string, index: number): number => {
  let inClass = false;
  for (let cursor = index + 1; cursor < src.length; cursor += 1) {
    const char = src[cursor];
    if (char === '\\') {
      cursor += 1;
      continue;
    }
    // A `/` inside `[…]` is a literal slash, not the terminator — `/[a-z/]/` is one regex.
    if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
    else if (char === '\n') return -1;
    else if (char === '/' && !inClass) {
      let flags = cursor + 1;
      while (flags < src.length && /[dgimsuvy]/.test(src[flags] as string)) flags += 1;
      return flags - 1;
    }
  }
  return -1;
};

/**
 * Where a string, template, comment or regex run starting at `index` ENDS, or `-1` when it never
 * does. `prev` is the last non-whitespace character before it, which is the only thing that tells
 * `value.replace(/'/g, …)` from `a / b`: a `/` after a VALUE is division and opens nothing.
 */
const runEnd = (src: string, index: number, prev: string | undefined): number => {
  const char = src[index];
  if (char === '/' && src[index + 1] === '/') {
    const end = src.indexOf('\n', index);
    return end < 0 ? -1 : end;
  }
  if (char === '/' && src[index + 1] === '*') {
    const end = src.indexOf('*/', index + 2);
    return end < 0 ? -1 : end + 1;
  }
  if (char === '/') return REGEX_PRECEDERS.has(prev) ? regexEnd(src, index) : index;
  if (char !== "'" && char !== '"' && char !== '`') return index;
  let cursor = index + 1;
  while (cursor < src.length && src[cursor] !== char) cursor += src[cursor] === '\\' ? 2 : 1;
  return cursor < src.length ? cursor : -1;
};

/**
 * The index of the `)` closing the `(` at `open`, or `-1` when the source is unbalanced.
 *
 * A regex cannot do this: `expect(up.indexOf('x')).toBeLessThan(…)` has a nested `)`, and a
 * non-greedy group stops at the inner one — the first draft of `index-of-order.ts` matched nothing
 * at all and read as a clean tree. Comments are skipped because this tree's comments are full of
 * backticks — `indexOf`, `BEGIN` — and one read as a template literal swallowed the rest of a scan,
 * so a correctly guarded site read as unguarded. `sql-scan.ts` records the same lesson for SQL.
 */
export function balancedClose(src: string, open: number): number {
  let depth = 0;
  let prev: string | undefined;
  for (let index = open; index < src.length; index += 1) {
    const char = src[index] as string;
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return index;
    } else if (!/\s/.test(char)) {
      const end = runEnd(src, index, prev);
      if (end < 0) return -1;
      index = end;
    }
    if (!/\s/.test(char)) prev = src[index] as string;
  }
  return -1;
}

/**
 * One call's arguments, split on TOP-LEVEL commas — `new RegExp("'", 'g')` stays one argument, and
 * so does `replace(/,/g, '')`, whose comma is inside a regex rather than between two arguments.
 */
export function topLevelArguments(inner: string): readonly string[] {
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  let prev: string | undefined;
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index] as string;
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    else if (char === ',' && depth === 0) {
      args.push(inner.slice(start, index).trim());
      start = index + 1;
    } else if (!/\s/.test(char)) {
      const end = runEnd(inner, index, prev);
      // An UNTERMINATED run swallows the rest: the alternative is reading its contents as
      // arguments, which is exactly the string-blindness this module exists to remove.
      if (end < 0) break;
      index = end;
    }
    if (!/\s/.test(char)) prev = inner[index] as string;
  }
  args.push(inner.slice(start).trim());
  return args;
}
