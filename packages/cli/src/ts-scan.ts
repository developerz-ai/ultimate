// Reading TypeScript source without a parser: the masking every scan here shares, and the `X_*`
// codes a package declares. Deliberately not `tsc` — a regex over a masked file is the whole job.
// Masking is the load-bearing part: the contract's own 3-line rendering appears verbatim in doc
// blocks and template literals, and a scanner that reads it as code invents work. What a `fix:`
// can evaluate to is `fix-scan.ts`, which reads these primitives and is the only file that grew.

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

export interface UnresolvedCodeSite extends SourceSite {
  /** The identifier exactly as written at the `code:` position. */
  readonly name: string;
}

/** One file's codes, and the names at a `code:` position this scan could not turn into one. */
export interface CodeScan {
  readonly sites: readonly CodeSite[];
  readonly unresolved: readonly UnresolvedCodeSite[];
}

// The masking itself — `QUOTES`, `endOfLiteral`, `stripComments`, `maskLiterals` — lives in
// `@ultimat3/core`'s `source-mask.ts` since 2026-09-05, because `@ultimat3/i18n`'s key extractor
// (tier 1) needed it and could not reach a tier-5 package. Re-exported here so every scanner in
// this package, and this package's public API, keep the names they had.
import { endOfLiteral, maskLiterals, QUOTES, stripComments } from '@ultimat3/core';

export { endOfLiteral, maskLiterals, QUOTES, stripComments };

// `ReadonlySet`, so a consumer cannot mutate what every scan in this package reads.
export const OPENERS: ReadonlySet<string> = new Set(['(', '[', '{']);
export const CLOSERS: ReadonlySet<string> = new Set([')', ']', '}']);

/**
 * Line numbers for one text, in one pass. Counting newlines per lookup is O(index), which a scan
 * asking for a line per literal pays once per literal — measured at ~15s over the framework's own
 * package tree, against ~1s for the same walk with this. One offset table, then a binary search.
 */
export function lineIndex(text: string): (index: number) => number {
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
 * Every string literal the value expression starting at `from` can EVALUATE TO, at the
 * expression's own bracket depth. Spanning the expression is what makes `cond ? 'a' : 'b'` and
 * `table[k] ?? 'c'` checkable instead of silently skipped; the depth rule is what keeps
 * `command.join(' ')`'s separator and `table['key']`'s key out — an argument is not a fix.
 *
 * A ternary's CONDITION is dropped, which is the difference between reading the expression and
 * reading every literal in it. `fix: input.slug === '' ? 'x g …' : 'x g …'` published the empty
 * string as a fix line — `X_ERROR_FIX_INVALID`, "the fix line is empty", against source whose two
 * real fixes are both correct — and `input.key === 'timeZone' ? … : …` published `timeZone`, a
 * string then judged for banned phrases and cited paths that is not a fix at all. Costly enough
 * that `@ultimat3/testing`'s island-state errors carry two classes under one code rather than one
 * class with a ternary in it.
 */
export function valueLiterals(
  masked: string,
  source: string,
  from: number,
  lineAt: (index: number) => number,
): readonly FixSite[] {
  const found: { value: string; index: number }[] = [];
  // The literals of the segment being read. A segment ended by `?` is a condition and is dropped
  // whole; one ended by `:` or by the end of the expression is a value the fix can evaluate to.
  let segment: { value: string; index: number }[] = [];
  const keep = (): void => {
    found.push(...segment);
    segment = [];
  };
  let depth = 0;
  /** Open `?`s still waiting for their `:`, so a `:` outside a ternary stays an ordinary char. */
  let conditionals = 0;
  for (let i = from; i < masked.length; i += 1) {
    const ch = masked[i] as string;
    if (QUOTES.has(ch)) {
      const end = endOfLiteral(masked, i);
      // A quote that never closes is one character of code, not an empty literal to report.
      if (end === i + 1) continue;
      if (depth === 0) segment.push({ value: source.slice(i + 1, end - 1), index: i });
      i = end - 1;
    } else if (OPENERS.has(ch)) depth += 1;
    else if (CLOSERS.has(ch)) {
      if (depth === 0) break;
      depth -= 1;
    } else if (depth === 0 && ch === '?') {
      // `??` and `?.` are operators and end no segment: `input?.fix ?? 'x help'` evaluates to the
      // literal, and dropping what came before it would drop the only answer the expression has.
      if (masked[i + 1] === '?') i += 1;
      else if (masked[i + 1] !== '.') {
        segment = [];
        conditionals += 1;
      }
    } else if (depth === 0 && ch === ':' && conditionals > 0) {
      keep();
      conditionals -= 1;
    } else if (depth === 0 && (ch === ',' || ch === ';')) break;
  }
  keep();
  return found.map((literal) => ({
    at: '',
    line: lineAt(literal.index),
    fix: literal.value,
  }));
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
 * A `code` KEY, and never a member assignment: `found.code = SOMETHING` projects somebody else's
 * code and declares none. The literal form above keeps its looser `\b` deliberately — a scanner
 * that stopped collecting a code it has collected for four majors would shrink the manifest.
 */
const CODE_KEY_POSITION = /(?<![.\w$])code\s*[:=]\s*/g;

/** Cheap enough to run on every file, so the masking pass below is paid only where it can pay. */
const HAS_CODE_IDENTIFIER = /(?<![.\w$])code\s*[:=]\s*[A-Za-z_$]/;

/** Sticky: the value expression is read at an exact offset, never out of a slice that may cut. */
const VALUE_IDENTIFIER = /([A-Za-z_$][\w$]*)\s*([.([]?)/y;

/**
 * A module-scope `const NAME = 'X_…'`, and the names of every other module-scope const. Anchored
 * at column 0, which is what makes it module scope without a parser: a `const` inside a function
 * can be shadowed by another in a sibling scope, and a resolver that picked one of them would be
 * guessing. The second set is the answer "that name IS declared here, and it is not a code" —
 * `const STATUS_NOT_FOUND = 404` in `@ultimat3/realtime`'s NATS fake is the live instance, and a
 * rule that reported it would be a rule the reader has to argue with.
 */
const CODE_CONST =
  /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=\s*(['"`])(X_[A-Z0-9_]+)\2/gm;
const MODULE_CONST = /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*[:=]/gm;

/** House shape for a constant. A lowercase name at a `code:` is a type annotation or a re-raise. */
const CODE_CONSTANT_NAME = /^[A-Z][A-Z0-9_]+$/;

interface ModuleConstants {
  /** Name → the code it holds. */
  readonly codes: ReadonlyMap<string, string>;
  /** Every module-scope const name, code-valued or not. */
  readonly names: ReadonlySet<string>;
}

function moduleConstants(text: string): ModuleConstants {
  const codes = new Map<string, string>();
  const names = new Set<string>();
  for (const match of text.matchAll(MODULE_CONST)) names.add(match[1] as string);
  for (const match of text.matchAll(CODE_CONST)) codes.set(match[1] as string, match[3] as string);
  return { codes, names };
}

/**
 * The bare identifier a key's value is, or `undefined` when the value is anything else. A member
 * read, an index and a call are all refused: `SEO_ERROR_CODES.metaMissing` is how two packages
 * raise every code they own, the registry branch below already collects those literals, and
 * judging the read would report eighteen working sites as broken.
 */
function valueIdentifier(masked: string, from: number): string | undefined {
  VALUE_IDENTIFIER.lastIndex = from;
  const match = VALUE_IDENTIFIER.exec(masked);
  return match === null || match[2] !== '' ? undefined : match[1];
}

/**
 * Codes this file declares: every `code:` / `code =` throw site, plus — in a package's own code
 * registry — every entry of its code list or title table, whichever shape it uses. A registry is
 * the only place a bare `X_*` literal is a declaration; anywhere else it is a reference (an env
 * var named `X_BUILD_ID`, an HTTP status map keyed by code) and collecting it would invent a code.
 *
 * A `code:` written as an IDENTIFIER is resolved against the module-scope consts of the same file,
 * and reported as `unresolved` when nothing there gives it a value (#277). Both halves matter and
 * neither is optional: `const STALE = 'X_DOC_PACKAGE_GRAPH_STALE'` is what a DRY author writes, and
 * a scan that skipped it silently left the code out of the manifest, out of `wiki/Error-Codes.md`'s
 * demanded rows, out of `bun run gate-codes` and out of `x errors explain` — permissive, and quiet.
 * The identifier half reads the MASKED text: `packages/cli/src/templates/` emits app source by the
 * dozen inside template literals, and a `code: STALE` in one of those is text, not a declaration.
 */
export function scanCodeDeclarations(source: string, at: string): CodeScan {
  const text = stripComments(source);
  const lineAt = lineIndex(text);
  const sites = new Map<string, CodeSite>();
  const unresolved: UnresolvedCodeSite[] = [];
  const add = (code: string, index: number): void => {
    if (!sites.has(code)) sites.set(code, { at, line: lineAt(index), code });
  };
  for (const match of text.matchAll(CODE_AT_KEY)) add(match[2] as string, match.index);
  if (HAS_CODE_IDENTIFIER.test(text)) {
    const masked = maskLiterals(source);
    const constants = moduleConstants(text);
    for (const key of masked.matchAll(CODE_KEY_POSITION)) {
      const name = valueIdentifier(masked, key.index + key[0].length);
      if (name === undefined) continue;
      const code = constants.codes.get(name);
      if (code !== undefined) add(code, key.index);
      else if (!constants.names.has(name) && CODE_CONSTANT_NAME.test(name)) {
        unresolved.push({ at, line: lineAt(key.index), name });
      }
    }
  }
  if (isCodeRegistry(text)) {
    for (const match of text.matchAll(CODE_LITERAL)) add(match[2] as string, match.index);
    for (const match of text.matchAll(CODE_KEY)) add(match[1] as string, match.index);
  }
  return { sites: [...sites.values()], unresolved };
}

/**
 * The codes alone, for every caller that has no report to attach a finding to. One scanner, one
 * answer: the manifest, the docs check, `bun run gate-codes` and `x errors explain` all read this.
 */
export const scanCodes = (source: string, at: string): readonly CodeSite[] =>
  scanCodeDeclarations(source, at).sites;

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

const CODE_NAME = /^X_[A-Z0-9_]+$/;

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
  // Lazily, because most files hold no `code:` at all and stripping is a whole extra pass over
  // the text. Same resolver `scanCodeDeclarations` reads, so `x errors explain` can never see a
  // smaller set of throw sites than the manifest does.
  let constants: ModuleConstants | undefined;
  const constantCode = (name: string | undefined): string | undefined => {
    if (name === undefined) return undefined;
    constants ??= moduleConstants(stripComments(source));
    return constants.codes.get(name);
  };
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
    if (key.kind === 'fix') {
      if (literal !== undefined && !fixes.has(scope)) fixes.set(scope, literal.fix);
      continue;
    }
    // A fix has no second reading, so it stays literal-only; a code has exactly one, which is the
    // module-scope const its own file declares it in.
    const code =
      literal === undefined ? constantCode(valueIdentifier(masked, key.from)) : literal.fix;
    if (code !== undefined && CODE_NAME.test(code) && !codes.has(scope)) {
      codes.set(scope, { at, line: literal?.line ?? lineAt(key.from), code });
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
