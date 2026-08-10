// Reading two things out of TypeScript source without a parser: the strings a `fix:` can evaluate
// to, and the `X_*` codes a package declares. Deliberately not `tsc` — the gate running this
// already spends a step on typecheck, and a regex over a masked file is the whole job. Masking is
// the load-bearing part: the contract's own 3-line rendering appears verbatim in several doc
// blocks and template literals, and a scanner that reads documentation as code reports findings
// nobody can fix.

export interface SourceSite {
  /** Repo-relative file the site was read from. */
  readonly at: string;
  readonly line: number;
}

export interface FixSite extends SourceSite {
  /** The literal exactly as written, `${…}` included. */
  readonly fix: string;
}

export interface CodeSite extends SourceSite {
  readonly code: string;
}

const QUOTES = new Set(["'", '"', '`']);
const OPENERS = new Set(['(', '[', '{']);
const CLOSERS = new Set([')', ']', '}']);

/** Index just past the closing quote of the literal opening at `from`, or the end of the text. */
function endOfLiteral(text: string, from: number): number {
  const quote = text[from] as string;
  for (let i = from + 1; i < text.length; i += 1) {
    if (text[i] === '\\') i += 1;
    else if (text[i] === quote) return i + 1;
  }
  return text.length;
}

/**
 * Comments — and optionally string contents — replaced by spaces, newlines kept so line numbers
 * survive and quote delimiters kept so the caller can still find where a literal starts and ends.
 */
function blankRegions(text: string, strings: boolean): string {
  const out = [...text];
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
    if (QUOTES.has(ch)) {
      const end = endOfLiteral(text, i);
      if (strings) blank(i + 1, end - 1);
      i = end;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/** Comments gone, string literals intact — what a scan for declared codes reads. */
export const stripComments = (text: string): string => blankRegions(text, false);

/** Comments and string contents gone, delimiters kept — what a scan for code structure reads. */
export const maskLiterals = (text: string): string => blankRegions(text, true);

const lineOf = (text: string, index: number): number => {
  let line = 1;
  for (let i = 0; i < index; i += 1) if (text[i] === '\n') line += 1;
  return line;
};

/**
 * Every string literal in the value expression starting at `from`, at the expression's own bracket
 * depth. Spanning the expression is what makes `cond ? 'a' : 'b'` and `table[k] ?? 'c'` checkable
 * instead of silently skipped; the depth rule is what keeps `command.join(' ')`'s separator and
 * `table['key']`'s key out — an argument is not a fix.
 */
function valueLiterals(masked: string, source: string, from: number): readonly FixSite[] {
  const found: { value: string; index: number }[] = [];
  let depth = 0;
  for (let i = from; i < masked.length; i += 1) {
    const ch = masked[i] as string;
    if (QUOTES.has(ch)) {
      const end = endOfLiteral(masked, i);
      if (depth === 0) found.push({ value: source.slice(i + 1, end - 1), index: i });
      i = end - 1;
    } else if (OPENERS.has(ch)) depth += 1;
    else if (CLOSERS.has(ch)) {
      if (depth === 0) break;
      depth -= 1;
    } else if (depth === 0 && (ch === ',' || ch === ';')) break;
  }
  return found.map((literal) => ({
    at: '',
    line: lineOf(masked, literal.index),
    fix: literal.value,
  }));
}

/** The lookbehind rejects member access: `cond ? e.fix : ''` is a ternary, not a declaration. */
const FIX_KEY = /(?<![.\w$])fix\s*:\s*/g;

/**
 * Every string a `fix:` can evaluate to. Searched over the masked source, so a `fix:` written
 * inside a doc comment or interpolated into a message is not mistaken for a declaration. A `fix`
 * computed at runtime — a bare identifier, a parameter, a table lookup with no literal fallback —
 * has nothing to read and is beyond a static scan; the gate says so rather than guessing.
 */
export function scanFixes(source: string, at: string): readonly FixSite[] {
  const masked = maskLiterals(source);
  const sites: FixSite[] = [];
  for (const key of masked.matchAll(FIX_KEY)) {
    const start = key.index + key[0].length;
    for (const literal of valueLiterals(masked, source, start)) sites.push({ ...literal, at });
  }
  return sites;
}

/** `packages/<pkg>/src/errors.ts` and core's `error-codes.ts`: one file per package, by rule. */
export const isCodeRegistry = (path: string): boolean =>
  /(?:^|\/)(?:errors|error-codes)\.ts$/.test(path);

const CODE_AT_KEY = /\bcode\s*[:=]\s*(['"`])(X_[A-Z0-9_]+)\1/g;
const CODE_LITERAL = /(['"`])(X_[A-Z0-9_]+)\1/g;
const CODE_KEY = /^[\t ]*(X_[A-Z0-9_]+)\s*:/gm;

/**
 * Codes this file declares: every `code:` / `code =` throw site, plus — in a package's own code
 * registry — every entry of its code list or title table, whichever shape it uses. A registry is
 * the only place a bare `X_*` literal is a declaration; anywhere else it is a reference (an env
 * var named `X_BUILD_ID`, an HTTP status map keyed by code) and collecting it would invent a code.
 */
export function scanCodes(source: string, at: string): readonly CodeSite[] {
  const text = stripComments(source);
  const sites = new Map<string, CodeSite>();
  const add = (code: string, index: number): void => {
    if (!sites.has(code)) sites.set(code, { at, line: lineOf(text, index), code });
  };
  for (const match of text.matchAll(CODE_AT_KEY)) add(match[2] as string, match.index);
  if (isCodeRegistry(at)) {
    for (const match of text.matchAll(CODE_LITERAL)) add(match[2] as string, match.index);
    for (const match of text.matchAll(CODE_KEY)) add(match[1] as string, match.index);
  }
  return [...sites.values()];
}
