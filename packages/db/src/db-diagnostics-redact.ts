// Single responsibility: a session's SQL text reduced to its shape before `x db diagnostics` prints
// it. `pg_stat_activity.query` is the text a client sent, literals and all, so a row value an
// unparameterised statement carried would otherwise reach a terminal, a log or an agent.

import { noiseAt } from './sql-scan';

/** Characters kept after redaction: enough to recognise a statement, never a whole report. */
export const QUERY_TEXT_MAX = 300;

/** Digits with Postgres 16's `_` separators between them (`1_234_567`). */
const DIGITS = String.raw`\d(?:_?\d)*`;

/**
 * A numeric literal standing alone: not part of a name (`t1`), not a placeholder (`$1`), not a
 * type modifier read off an identifier (`int4`). Lookbehind keeps the preceding character. The
 * Postgres 16 spellings are one literal each: `0x`/`0o`/`0b` with any digits and `_` after it,
 * and `_` between digits in the whole, fractional and exponent parts.
 */
const NUMERIC = new RegExp(
  String.raw`(?<![A-Za-z0-9_$."])(?:0[xob][0-9a-f_]+|(?:${DIGITS}(?:\.(?:${DIGITS})?)?|\.${DIGITS})(?:e[+-]?${DIGITS})?)`,
  'gi',
);

/**
 * Literals (string, escape string, dollar-quoted, numeric) become `?`, comments go, quoted
 * identifiers and `$n` placeholders stay. Walked with `sql-scan.ts`'s `noiseAt`, the package's one
 * lexer, so a `--` inside a literal is data here exactly as it is to the destructive rail. A
 * literal the server truncated mid-way runs to the end of the text and is redacted whole.
 */
export function redactQueryText(text: string): string {
  let out = '';
  let plain = '';
  const flush = (): void => {
    out += plain.replace(NUMERIC, '?');
    plain = '';
  };
  let index = 0;
  while (index < text.length) {
    const noise = noiseAt(text, index);
    if (noise === null) {
      plain += text[index];
      index += 1;
      continue;
    }
    flush();
    if (noise.kind === 'identifier') out += text.slice(index, noise.end);
    else if (noise.kind === 'string' || noise.kind === 'dollar-body') out += '?';
    else out += ' ';
    index = noise.end;
  }
  flush();
  // An escape-string prefix (`E'…'`, `X'…'`) is left as a lone letter before its `?`.
  const shaped = out
    .replace(/(?<![A-Za-z0-9_$])[ebxun]&?\?/gi, '?')
    .replace(/\s+/g, ' ')
    .trim();
  return shaped.length > QUERY_TEXT_MAX ? `${shaped.slice(0, QUERY_TEXT_MAX)}…` : shaped;
}
