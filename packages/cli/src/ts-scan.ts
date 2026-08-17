// Reading two things out of TypeScript source without a parser: the strings a `fix:` can evaluate
// to, and the `X_*` codes a package declares. Deliberately not `tsc` — a regex over a masked file
// is the whole job. Masking is the load-bearing part: the contract's own 3-line rendering appears
// verbatim in doc blocks and template literals, and a scanner that reads it as code invents work.

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
const WORD = /[\w$]/;

/** After one of these words a `/` opens a regex; after any other identifier it divides. */
const REGEX_AFTER_WORDS = new Set(
  'await case delete do else in instanceof new of return throw typeof void yield'.split(' '),
);

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

/** Comments gone, string literals intact — what a scan for declared codes reads. */
export const stripComments = (text: string): string => blankRegions(text, false);

/** Comments and string contents gone, delimiters kept — what a scan for code structure reads. */
export const maskLiterals = (text: string): string => blankRegions(text, true);

/**
 * Line numbers for one text, in one pass. Counting newlines per lookup is O(index), which a scan
 * asking for a line per literal pays once per literal — measured at ~15s over the framework's own
 * package tree, against ~1s for the same walk with this. One offset table, then a binary search.
 */
function lineIndex(text: string): (index: number) => number {
  const newlines: number[] = [];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') newlines.push(i);
  return (index) => {
    let low = 0;
    let high = newlines.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if ((newlines[mid] as number) < index) low = mid + 1;
      else high = mid;
    }
    return low + 1;
  };
}

/**
 * Every string literal in the value expression starting at `from`, at the expression's own bracket
 * depth. Spanning the expression is what makes `cond ? 'a' : 'b'` and `table[k] ?? 'c'` checkable
 * instead of silently skipped; the depth rule is what keeps `command.join(' ')`'s separator and
 * `table['key']`'s key out — an argument is not a fix.
 */
function valueLiterals(
  masked: string,
  source: string,
  from: number,
  lineAt: (index: number) => number,
): readonly FixSite[] {
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
    line: lineAt(literal.index),
    fix: literal.value,
  }));
}

/** The lookbehind rejects member access: `cond ? e.fix : ''` is a ternary, not a declaration. */
const FIX_KEY = /(?<![.\w$])fix\s*:\s*/g;

/** Text between the bracket at `open` and its match, or `undefined` when it never closes. */
function bracketSpan(masked: string, open: number): string | undefined {
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    const ch = masked[i] as string;
    // Only `()[]{}`. An angle bracket is a generic in a parameter list and the tail of `=>` in the
    // very same list, so counting it makes `(fn: () => void)` end the span in the wrong place.
    if (OPENERS.has(ch)) depth += 1;
    else if (CLOSERS.has(ch)) {
      depth -= 1;
      if (depth === 0) return masked.slice(open + 1, i);
    }
  }
  return undefined;
}

/** Split at depth-0 commas. Safe on masked text, where a comma inside a literal is already gone. */
function topLevelParts(text: string): readonly string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] as string;
    if (OPENERS.has(ch)) depth += 1;
    else if (CLOSERS.has(ch)) depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** A local function that builds an error and takes its fix positionally, and where in its list. */
interface FixHelper {
  readonly name: string;
  readonly index: number;
}

const HELPER_DECL =
  /(?<![.\w$])(?:function\s+([A-Za-z_$][\w$]*)\s*\(|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*(?:async\s+)?\()/g;

const FIX_PARAM = /^\s*fix\s*:\s*string\s*$/;

/**
 * What separates a helper that BUILDS a fix from one that CONSUMES one. `citedCommandProblem(fix:
 * string, …)` in `fix-command.ts` takes a fix in order to judge it, and reading its call sites as
 * declarations would report findings about strings that are already findings. A builder names a
 * `code` or constructs an `…Error`; a consumer does neither.
 */
const BUILDS_ERROR = /(?<![.\w$])code\s*[:=]|new\s+[A-Za-z_$][\w$]*Error\s*\(/;

/** The body braces of the declaration whose parameter list ends at `after`. */
function bodyOf(masked: string, after: number): string {
  const brace = masked.indexOf('{', after);
  return brace === -1 ? '' : (bracketSpan(masked, brace) ?? '');
}

function fixHelpers(masked: string): readonly FixHelper[] {
  const helpers: FixHelper[] = [];
  for (const declaration of masked.matchAll(HELPER_DECL)) {
    const name = declaration[1] ?? declaration[2];
    const open = declaration.index + declaration[0].length - 1;
    if (name === undefined || masked[open] !== '(') continue;
    const params = bracketSpan(masked, open);
    // A rest parameter makes the position of everything after it unknowable, and a destructured
    // one has no position at all — its `fix:` key at the CALL site is already read by `FIX_KEY`.
    if (params === undefined || params.includes('...')) continue;
    const parts = topLevelParts(params);
    if (parts.some((part) => /^\s*[[{]/.test(part))) continue;
    const index = parts.findIndex((part) => FIX_PARAM.test(part));
    if (index === -1) continue;
    if (!BUILDS_ERROR.test(bodyOf(masked, open + params.length + 2))) continue;
    helpers.push({ name, index });
  }
  return helpers;
}

/**
 * The argument in that position at every call to that helper IN THIS FILE.
 *
 * Same file, deliberately: resolving `dbNotImplemented` imported from `@ultimat3/db` would mean a
 * cross-file symbol table, and a scanner that guessed at which import a name came from would read
 * an unrelated function's argument as a fix. The gap that leaves is named in `CLAUDE.md`.
 */
function helperFixSites(
  masked: string,
  source: string,
  at: string,
  helper: FixHelper,
  lineAt: (index: number) => number,
): readonly FixSite[] {
  const sites: FixSite[] = [];
  // The lookbehind is `FIX_KEY`'s: `reporter.rejected(…)` is some other object's method.
  const call = new RegExp(`(?<![.\\w$])${helper.name}\\s*\\(`, 'g');
  for (const match of masked.matchAll(call)) {
    const open = match.index + match[0].length - 1;
    const args = bracketSpan(masked, open);
    if (args === undefined) continue;
    const parts = topLevelParts(args);
    const argument = parts[helper.index];
    if (argument === undefined) continue;
    // Stricter than the `fix:` path, and deliberately: the whole argument must BE one literal.
    // `valueLiterals` alone reads `prefix + 'x doctor'` as one literal, because the identifier
    // half contributes none — and publishing half a fix as the whole one is the failure
    // `soleLiteral` already names. A key at least declares that what follows is the value.
    const quote = argument.trim()[0];
    if (quote === undefined || !QUOTES.has(quote)) continue;
    const literal = argument.indexOf(quote);
    if (argument.slice(endOfLiteral(argument, literal)).trim() !== '') continue;
    const from = parts.slice(0, helper.index).reduce((n, part) => n + part.length + 1, open + 1);
    const literals = valueLiterals(masked, source, from, lineAt);
    if (literals.length === 1) sites.push({ ...(literals[0] as FixSite), at });
  }
  return sites;
}

/**
 * Every string a `fix:` can evaluate to. Searched over the masked source, so a `fix:` written
 * inside a doc comment or interpolated into a message is not mistaken for a declaration. A `fix`
 * computed at runtime — a bare identifier, a parameter, a table lookup with no literal fallback —
 * has nothing to read and is beyond a static scan; the gate says so rather than guessing.
 *
 * Two shapes, because a fix does not always arrive under a key. `@ultimat3/mcp`'s `readonly-sql.ts`
 * hands every one of its fixes positionally to a local `rejected(cause, fix)` helper, so the key
 * rule alone returned `[]` for the whole file — 20 non-test files in that package and the scanner
 * saw fixes in three — and two stale `x db branch <name>` lines shipped through the hole.
 */
export function scanFixes(source: string, at: string): readonly FixSite[] {
  const masked = maskLiterals(source);
  const lineAt = lineIndex(masked);
  const sites: FixSite[] = [];
  for (const key of masked.matchAll(FIX_KEY)) {
    const start = key.index + key[0].length;
    for (const literal of valueLiterals(masked, source, start, lineAt)) {
      sites.push({ ...literal, at });
    }
  }
  for (const helper of fixHelpers(masked)) {
    sites.push(...helperFixSites(masked, source, at, helper, lineAt));
  }
  return sites;
}

const CODE_TABLE = /\bexport const [A-Z][A-Z0-9_]*_ERROR_(?:CODES|TITLES)\b/;

/**
 * Whether a file IS a package's code registry — asked of its contents, not of its name.
 *
 * A filename test (`errors.ts` or `error-codes.ts`) held only while one file per package did both
 * jobs. The moment `@ultimat3/cli`'s split under the 500-line ceiling — table into `error-codes.ts`,
 * classes into `errors.ts` — the classes file was still *named* like a registry, so every code it
 * throws outranked the package that actually owns it and `X_NOT_IMPLEMENTED` moved from `core` to
 * `cli` in the manifest. The table is the thing; `export const <PKG>_ERROR_{CODES,TITLES}` is the
 * one shape every package declares it in, and `x verify`'s `errors` step is what keeps that true.
 */
export const isCodeRegistry = (source: string): boolean => CODE_TABLE.test(source);

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
  const lineAt = lineIndex(text);
  const sites = new Map<string, CodeSite>();
  const add = (code: string, index: number): void => {
    if (!sites.has(code)) sites.set(code, { at, line: lineAt(index), code });
  };
  for (const match of text.matchAll(CODE_AT_KEY)) add(match[2] as string, match.index);
  if (isCodeRegistry(text)) {
    for (const match of text.matchAll(CODE_LITERAL)) add(match[2] as string, match.index);
    for (const match of text.matchAll(CODE_KEY)) add(match[1] as string, match.index);
  }
  return [...sites.values()];
}

export interface CodeFixSite extends CodeSite {
  /**
   * The fix literal exactly as written, `${…}` included. Absent when the throw site builds its
   * fix out of something this cannot read — a helper call, a parameter, a ternary with two
   * branches — because a fix the scan has to guess at is one it must not report.
   */
  readonly fix?: string;
}

/** `code:` / `code =`, or `fix:`. `fix =` is deliberately not a declaration — `scanFixes` agrees. */
const CODE_OR_FIX_KEY = /(?<![.\w$])(?:(code)\s*[:=]|(fix)\s*:)\s*/g;

/**
 * The single literal a key's value evaluates to, or `undefined` when it evaluates to none or to
 * more than one. Two is as unreadable as zero here: `cond ? 'a' : 'b'` and `'a' + 'b'` need a
 * parser to tell apart, and picking a branch would publish half a fix as the whole one.
 */
function soleLiteral(
  masked: string,
  source: string,
  from: number,
  lineAt: (index: number) => number,
): FixSite | undefined {
  const found = valueLiterals(masked, source, from, lineAt);
  return found.length === 1 ? found[0] : undefined;
}

/**
 * Every `X_*` code paired with the `fix:` written beside it — in the SAME object literal, which is
 * the whole rule. `new UltimateError({ code, cause, fix })` is the one shape this framework raises
 * an error in, so adjacency decides the pair without a parser and without asking which of a file's
 * fixes belongs to which of its codes. `X_ERROR_FIX_INVALID` already proves every one of these is
 * runnable, so a reader that projects them inherits that proof instead of restating it (axiom 2).
 *
 * A site is reported with no `fix` rather than dropped: "this code is raised here and the fix is
 * computed" is a different, and more useful, answer than "this code does not exist".
 */
export function scanCodeFixSites(source: string, at: string): readonly CodeFixSite[] {
  const masked = maskLiterals(source);
  const lineAt = lineIndex(masked);
  const keys = new Map<number, { readonly kind: 'code' | 'fix'; readonly from: number }>();
  for (const key of masked.matchAll(CODE_OR_FIX_KEY)) {
    keys.set(key.index, {
      kind: key[1] === undefined ? 'fix' : 'code',
      from: key.index + key[0].length,
    });
  }
  const codes = new Map<number, CodeSite>();
  const fixes = new Map<number, string>();
  const stack: number[] = [];
  for (let i = 0; i < masked.length; i += 1) {
    const ch = masked[i] as string;
    if (QUOTES.has(ch)) {
      i = endOfLiteral(masked, i) - 1;
      continue;
    }
    if (OPENERS.has(ch)) {
      stack.push(i);
      continue;
    }
    if (CLOSERS.has(ch)) {
      stack.pop();
      continue;
    }
    const key = keys.get(i);
    // Scope `-1` is the file body: a top-level `const code = 'X_A'` and an unrelated `fix:` far
    // below it are not one declaration, and pairing them would invent an error nobody throws.
    const scope = stack.at(-1);
    if (key === undefined || scope === undefined) continue;
    const literal = soleLiteral(masked, source, key.from, lineAt);
    if (literal === undefined) continue;
    if (key.kind === 'fix') {
      if (!fixes.has(scope)) fixes.set(scope, literal.fix);
    } else if (/^X_[A-Z0-9_]+$/.test(literal.fix) && !codes.has(scope)) {
      codes.set(scope, { at, line: literal.line, code: literal.fix });
    }
  }
  return [...codes].map(([scope, site]) => {
    const fix = fixes.get(scope);
    return fix === undefined ? site : { ...site, fix };
  });
}

const BORROWED_LIST = /BORROWED_ERROR_CODES[^=]*=[^[]*\[([^\]]*)\]/g;

/**
 * The codes a registry names and says are not its own. Every borrower declares them in one place
 * and one shape — `export const CLI_BORROWED_ERROR_CODES = ['X_NOT_IMPLEMENTED'] as const` — so
 * "who owns this code?" is answerable from source rather than guessed at. Without it the answer
 * for a code eleven packages throw and one titles is whichever file sorts first, which is how
 * `X_NOT_IMPLEMENTED` came to be attributed to `storage` instead of `core`.
 */
export function scanBorrowedCodes(source: string): ReadonlySet<string> {
  const borrowed = new Set<string>();
  for (const list of stripComments(source).matchAll(BORROWED_LIST)) {
    for (const code of (list[1] ?? '').matchAll(CODE_LITERAL)) borrowed.add(code[2] as string);
  }
  return borrowed;
}
