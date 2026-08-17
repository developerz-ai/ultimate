// Single responsibility: blank everything a keyword could legitimately hide inside — comments,
// literals, quoted identifiers, dollar-quoted bodies — so a reader judging SQL text sees the
// operation and not the prose around it. Two readers share it (`readOnlyQuery`'s cursorable check,
// the destructive rail), and one wrong answer here is a wrong answer in both.

import { noiseAt } from './sql-scan';

/** What each blanked span leaves behind. A quote pair stays a token; a comment becomes a gap. */
const BLANK: Readonly<Record<string, string>> = {
  'line-comment': ' ',
  'block-comment': ' ',
  'dollar-body': ' ',
  string: " '' ",
  identifier: ' "" ',
};

/**
 * Comments, literals, quoted identifiers and dollar-quoted bodies, each replaced by whitespace or
 * an empty quote pair.
 *
 * Scanned in source order rather than by a sequence of replacements, and that ordering is the
 * whole guard: blanking comments first reads the `--` in `select '--'; delete from posts` as a
 * comment and erases the `delete` with it, so anything reading the blanked text sees a SELECT
 * where a mutating statement was. `sql-noise.test.ts` pins that case and the four beside it.
 */
export function stripSqlNoise(text: string): string {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const noise = noiseAt(text, index);
    if (noise === null) {
      out += text[index];
      index += 1;
      continue;
    }
    out += BLANK[noise.kind] ?? ' ';
    index = noise.end;
  }
  return out;
}
