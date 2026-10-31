// Single responsibility: whether a migration DECLARES something with a marker line — a top-level
// `--` comment of its own, and nothing that merely looks like one. Two markers ask this question
// (`-- destructive: true`, `-- transaction: false`), so the scan is written once.

import { noiseAt } from './sql-scan';

/** Whether only spaces and tabs separate `index` from the start of its line. */
function startsLine(sql: string, index: number): boolean {
  for (let at = index - 1; at >= 0; at -= 1) {
    const char = sql[at];
    if (char === '\n') return true;
    if (char !== ' ' && char !== '\t') return false;
  }
  return true;
}

/**
 * Declared only where a reader would see it: a top-level `--` line of its own, whose WHOLE text
 * `marker` matches.
 *
 * A regex over the raw file matched a marker inside `/* … *\/` and inside a dollar-quoted body,
 * where it declares nothing and no reviewer reading the diff would call it a declaration. Scanning
 * is what tells a comment from a comment about a comment; a marker is a lexical fact, not a
 * substring.
 */
export function hasMarkerLine(sql: string, marker: RegExp): boolean {
  let index = 0;
  while (index < sql.length) {
    const noise = noiseAt(sql, index);
    if (noise === null) {
      index += 1;
      continue;
    }
    const text = sql.slice(index, noise.end);
    if (noise.kind === 'line-comment' && startsLine(sql, index) && marker.test(text)) return true;
    index = noise.end;
  }
  return false;
}
