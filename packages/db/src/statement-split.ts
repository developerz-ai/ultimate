// Single responsibility: cut a SQL script into the statements a driver sends one at a time —
// one send is one statement, or the server answers `cannot insert multiple commands into a
// prepared statement`. Where a `;` separates and where it is data is `sql-scan.ts`'s answer.

import { noiseAt } from './sql-scan';

const WHITESPACE = /\s/;

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
    if (char === ';') {
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
