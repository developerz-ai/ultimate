// The `test`/`it` titles a test file declares, in source order — what `vanished-tests` compares
// across a diff. Read off the MASKED source (comments and string contents blanked, offsets kept),
// so a title in a comment or a string is never one, and the title text is then cut from the
// original at the offsets the mask found.

import { maskLiterals } from '../../packages/core/src/source-mask';

/** `test` or `it` as a call's own name: not a property (`obj.test`), not part of a longer word. */
const CALLEE = /(?<![\w$.])(?:test|it)\b/g;
const QUOTES = new Set(["'", '"', '`']);

/** The index past the `(`…`)` or `` ` ``…`` ` `` opening at `at` in the masked text, or -1. */
function skipGroup(masked: string, at: number): number {
  const open = masked[at];
  if (open === '`') {
    const close = masked.indexOf('`', at + 1);
    return close === -1 ? -1 : close + 1;
  }
  if (open !== '(') return -1;
  let depth = 0;
  for (let index = at; index < masked.length; index += 1) {
    if (masked[index] === '(') depth += 1;
    else if (masked[index] === ')') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

const skipSpace = (text: string, at: number): number => {
  let index = at;
  while (index < text.length && /\s/.test(text[index] ?? '')) index += 1;
  return index;
};

/**
 * The title of the call whose name ends at `at`: past any `.modifier` / `.modifier(…)` /
 * `.each`…`` ` `` chain, the first argument of the call, when it is a string literal.
 */
function titleAt(source: string, masked: string, at: number): string | undefined {
  let index = skipSpace(masked, at);
  while (masked[index] === '.') {
    const name = /^\.\s*[A-Za-z_$][\w$]*/.exec(masked.slice(index));
    if (name === null) return undefined;
    index = skipSpace(masked, index + name[0].length);
    // A modifier's own arguments (`.if(cond)`, `.each([...])`, `` .each`table` ``) when another
    // call or modifier follows them; otherwise this group IS the call that carries the title.
    if (masked[index] !== '(' && masked[index] !== '`') continue;
    const after = skipGroup(masked, index);
    if (after === -1) return undefined;
    const next = skipSpace(masked, after);
    if (masked[next] !== '(' && masked[next] !== '.') break;
    index = next;
  }
  if (masked[index] !== '(') return undefined;
  const open = skipSpace(masked, index + 1);
  const quote = masked[open] ?? '';
  if (!QUOTES.has(quote)) return undefined;
  const close = masked.indexOf(quote, open + 1);
  return close === -1 ? undefined : source.slice(open + 1, close);
}

/** Every `test`/`it` title in `source`, in order; a call whose first argument is no literal has none. */
export function testTitles(source: string): readonly string[] {
  const masked = maskLiterals(source);
  const titles: string[] = [];
  for (const match of masked.matchAll(CALLEE)) {
    const title = titleAt(source, masked, match.index + match[0].length);
    if (title !== undefined) titles.push(title);
  }
  return titles;
}
