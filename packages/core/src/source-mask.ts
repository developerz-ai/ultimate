// Reading TypeScript source without a parser: comments — and optionally string contents — replaced
// by spaces, newlines kept so line numbers survive. Moved here from `@ultimat3/cli`'s `ts-scan.ts`
// on 2026-09-05 because `@ultimat3/i18n`'s key extractor (tier 1) needed exactly this and could not
// import a tier-5 package: a `// … t('…')` in a comment was a phantom key `x i18n sync` would have
// written as `"…": "⟦…⟧"`. One masking implementation, at the tier every scanner can reach.

// `ReadonlySet`, so a consumer cannot mutate what every scan reads.
export const QUOTES: ReadonlySet<string> = new Set(["'", '"', '`']);
const WORD = /[\w$]/;

/** After one of these words a `/` opens a regex; after any other identifier it divides. */
const REGEX_AFTER_WORDS = new Set(
  'await case delete do else in instanceof new of return throw typeof void yield'.split(' '),
);

/**
 * Index just past the closing quote of the literal opening at `from`, or `from + 1` when a `'`/`"`
 * does not close on its own line — which makes it text, not a literal. Only a template literal may
 * span a newline, so the apostrophe in `<p>Don't panic</p>` is JSX text; read as an opener it ran
 * forward to the next `'` in the FILE (the next `fix:` line) and blanked every declaration between,
 * silently emptying the `errors` gate for the whole file. Same rule `endOfRegex` applies to a `/`.
 * An escaped newline is still a continuation: the escape is consumed before the line test.
 */
export function endOfLiteral(text: string, from: number): number {
  const quote = text[from] as string;
  const spansLines = quote === '`';
  for (let i = from + 1; i < text.length; i += 1) {
    if (text[i] === '\\') i += 1;
    else if (text[i] === quote) return i + 1;
    else if (!spansLines && text[i] === '\n') return from + 1;
  }
  return spansLines ? text.length : from + 1;
}

/**
 * Whether the `/` at `at` opens a regex rather than divides — the call no scanner without a parser
 * avoids. A regex cannot follow what ends an expression: an identifier that is not one of the words
 * above, a number, `)`, `]`, a string's closing quote. Every other position is an operator's and
 * opens one; `</` and `/>` are JSX delimiters. Read from the masked prefix, so a comment is space.
 */
function opensRegex(out: readonly string[], at: number): boolean {
  if (out[at + 1] === '>') return false;
  let i = at - 1;
  while (i >= 0 && /\s/.test(out[i] as string)) i -= 1;
  if (i < 0) return true;
  const ch = out[i] as string;
  if (ch === '<' || ch === ')' || ch === ']' || QUOTES.has(ch)) return false;
  if (!WORD.test(ch)) return true;
  let start = i;
  while (start >= 0 && WORD.test(out[start] as string)) start -= 1;
  return REGEX_AFTER_WORDS.has(out.slice(start + 1, i + 1).join(''));
}

/**
 * Index just past the closing `/` of the regex opening at `from`, or `from + 1` when it does not
 * close on its own line — a literal may not span one, so an unterminated candidate was a division
 * or a JSX delimiter after all. A `/` inside a `[…]` class does not close the literal.
 */
function endOfRegex(text: string, from: number): number {
  let inClass = false;
  let escaped = false;
  for (let i = from + 1; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\n') break;
    if (escaped) escaped = false;
    else if (ch === '\\') escaped = true;
    else if (inClass) inClass = ch !== ']';
    else if (ch === '[') inClass = true;
    else if (ch === '/') return i + 1;
  }
  return from + 1;
}

/**
 * Comments — and optionally string contents — replaced by spaces, newlines kept so line numbers
 * survive and quote delimiters kept so the caller can still find where a literal starts and ends.
 * A regex body is masked the same way: `/(['"`])/` holds three quotes that delimit nothing, and
 * reading one as an opening quote desyncs every literal after it.
 */
function blankRegions(text: string, strings: boolean): string {
  // `split('')` and NOT `[...text]`: the spread yields one element per CODE POINT while every
  // index below runs over UTF-16 units (`text.length`, `text[i]`). One astral character — an emoji
  // in a fixture, `piñata 🎉` — and `out` is shorter than `text`, so every write past it lands a
  // slot early and the returned mask no longer aligns with the input. Measured: 22 files in this
  // tree desynced, shipped source included, and eight rules read this mask.
  const out = text.split('');
  const blank = (from: number, to: number): void => {
    for (let n = from; n < to; n += 1) if (out[n] !== '\n') out[n] = ' ';
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      const line = text[i + 1] === '/';
      const end = line ? text.indexOf('\n', i) : text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : line ? end : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    // Not code: a regex body or a literal. `end === i + 1` blanks nothing and steps one char.
    const end =
      ch === '/' && opensRegex(out, i)
        ? endOfRegex(text, i)
        : QUOTES.has(ch)
          ? endOfLiteral(text, i)
          : i + 1;
    if (strings) blank(i + 1, end - 1);
    i = end;
  }
  return out.join('');
}

/** Comments gone, string literals intact — what a scan for declared codes or `t()` keys reads. */
export const stripComments = (text: string): string => blankRegions(text, false);

/** Comments and string contents gone, delimiters kept — what a scan for code structure reads. */
export const maskLiterals = (text: string): string => blankRegions(text, true);
