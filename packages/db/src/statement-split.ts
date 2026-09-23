// Single responsibility: cut a SQL script into the statements a driver sends one at a time —
// one send is one statement, or the server answers `cannot insert multiple commands into a
// prepared statement`. Where a `;` separates and where it is data is `sql-scan.ts`'s answer.

import { noiseAt } from './sql-scan';

const WHITESPACE = /\s/;
const WORD_START = /[A-Za-z_]/;
const WORD = /[A-Za-z0-9_$]/;

/**
 * The blocks a `;` does not end. A PG14+ SQL-standard function body — `begin atomic … end` — holds
 * whole statements, so its inner `;` is data; reproduced on PGlite, cutting there sent `create
 * function … begin atomic select 1` alone (`syntax error at end of input`) and ran the rest of the
 * body as top-level statements. A `case … end` inside such a body is tracked too, or its `end`
 * would close the body early. Outside an atomic body nothing is tracked, so `begin; … end;` — a
 * transaction — splits exactly as it always did.
 */
function trackBlocks(stack: string[], word: string, previous: string): void {
  if (word === 'atomic' && previous === 'begin') stack.push('atomic');
  else if (stack.length === 0) return;
  else if (word === 'case') stack.push('case');
  else if (word === 'end') stack.pop();
}

const isComment = (kind: string): boolean => kind === 'line-comment' || kind === 'block-comment';

/**
 * The statements of `script`, in order, each without its separator.
 *
 * A chunk holding only whitespace and comments is **not** a statement and is dropped: an empty
 * `up`, or one whose tail is the `-- backfill …, then: …;` note `generateMigration` emits, would
 * otherwise reach the driver as an empty query.
 */
export function statementsOf(script: string): readonly string[] {
  const statements: string[] = [];
  let start = 0;
  let index = 0;
  // Set by anything that is not whitespace and not inside a comment: what makes a chunk a
  // statement rather than a note between two of them.
  let content = false;
  const blocks: string[] = [];
  let previous = '';

  const cut = (end: number): void => {
    const text = content ? script.slice(start, end).trim() : '';
    if (text.length > 0) statements.push(text);
    content = false;
  };

  while (index < script.length) {
    const noise = noiseAt(script, index);
    if (noise !== null) {
      if (!isComment(noise.kind)) content = true;
      index = noise.end;
      continue;
    }
    const char = script[index] ?? '';
    // A word starts only after a non-word character, so `x_begin` is not `begin`.
    if (WORD_START.test(char) && !WORD.test(script[index - 1] ?? ' ')) {
      let end = index + 1;
      while (end < script.length && WORD.test(script[end] ?? '')) end += 1;
      const word = script.slice(index, end).toLowerCase();
      trackBlocks(blocks, word, previous);
      previous = word;
      content = true;
      index = end;
      continue;
    }
    if (char === ';' && blocks.length === 0) {
      cut(index);
      start = index + 1;
      index += 1;
      continue;
    }
    if (!WHITESPACE.test(char)) content = true;
    index += 1;
  }
  cut(script.length);
  return statements;
}
