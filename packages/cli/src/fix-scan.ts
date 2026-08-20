// Every string a `fix:` can evaluate to, in the three shapes a fix arrives in: under a key, in the
// argument position of a factory that builds an error, and in the argument position of an error
// class's constructor. Split out of `ts-scan.ts` when the third shape and cross-file resolution
// (`fix-imports.ts`) took the file past the 500-line ceiling; the masking primitives stay there.

import type { FixSite } from './ts-scan';
import {
  CLOSERS,
  endOfLiteral,
  lineIndex,
  maskLiterals,
  OPENERS,
  QUOTES,
  valueLiterals,
} from './ts-scan';

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

/** A callable that builds an error and takes its fix positionally, and where in its list. */
export interface FixHelper {
  readonly name: string;
  readonly index: number;
}

const HELPER_DECL =
  /(?<![.\w$])(?:function\s+([A-Za-z_$][\w$]*)\s*\(|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*(?:async\s+)?\()/g;

/**
 * A class, and — because the helper's NAME is the class's and the parameter list is its
 * constructor's — the two are found in two steps rather than one regex. `@ultimat3/render`'s
 * `errors.ts` declares fourteen of these taking `(cause, fix)` positionally, and until this the
 * form was unread everywhere: measured over the tree, it has ZERO same-file call sites, so the
 * same-file rule was dead code for it and 15 of render's codes never had a fix line checked.
 */
const CLASS_DECL = /(?<![.\w$])class\s+([A-Za-z_$][\w$]*)[^{;]*\{/g;
const CONSTRUCTOR = /(?<![.\w$])constructor\s*\(/;

const FIX_PARAM = /^\s*fix\s*:\s*string\s*$/;

/**
 * What separates a helper that BUILDS a fix from one that CONSUMES one. `citedCommandProblem(fix:
 * string, …)` in `fix-command.ts` takes a fix in order to judge it, and reading its call sites as
 * declarations would report findings about strings that are already findings. A builder names a
 * `code` or constructs an `…Error`; a consumer does neither.
 */
const BUILDS_ERROR = /(?<![.\w$])code\s*[:=]|new\s+[A-Za-z_$][\w$]*Error\s*\(/;

/**
 * The body of the declaration whose parameter list ends at `after`, and never a `{` belonging to
 * something below it. An unbounded `indexOf('{')` reads the next object literal in the FILE when
 * the body is a concise expression, so `const label = (fix: string) => fix.trim();` followed
 * anywhere by a `{ code: … }` was read as an error builder and every `label(…)` call handed the
 * gate a string to judge as a fix — a false gate failure over innocent source.
 *
 * The scan therefore ends at the `;` that ends the declaration, or at a bracket closing a scope
 * this declaration is inside. Both directions of that bound answer `''`, which classifies the
 * helper as a non-builder: a missed fix line costs one unchecked citation, a wrongly claimed one
 * costs a build. A `{` inside a return-type annotation (`(): { ok: boolean } => …`) is read as the
 * body and answers `''` for the same reason.
 */
function bodyOf(masked: string, after: number): string {
  for (let i = after; i < masked.length; i += 1) {
    const ch = masked[i] as string;
    if (ch === '{') return bracketSpan(masked, i) ?? '';
    if (ch === ';' || CLOSERS.has(ch)) break;
  }
  return '';
}

/**
 * One declaration judged: it must build an error, and its fix must sit at a position a call site
 * can be read at. A rest parameter makes the position of everything after it unknowable, and a
 * destructured one has no position at all — its `fix:` key at the CALL site is already read by
 * `FIX_KEY`.
 */
function helperAt(masked: string, name: string, open: number): FixHelper | undefined {
  const params = bracketSpan(masked, open);
  if (params === undefined || params.includes('...')) return undefined;
  const parts = topLevelParts(params);
  if (parts.some((part) => /^\s*[[{]/.test(part))) return undefined;
  const index = parts.findIndex((part) => FIX_PARAM.test(part));
  if (index === -1) return undefined;
  if (!BUILDS_ERROR.test(bodyOf(masked, open + params.length + 2))) return undefined;
  return { name, index };
}

/**
 * Every fix-building callable this file declares — a function, an arrow bound to a const, or a
 * class whose constructor takes the fix. Exported because `fix-imports.ts` asks the same question
 * of a file this one merely imports FROM; there is no second reader of a declaration.
 */
export function scanFixHelpers(masked: string): readonly FixHelper[] {
  const helpers: FixHelper[] = [];
  for (const declaration of masked.matchAll(HELPER_DECL)) {
    const name = declaration[1] ?? declaration[2];
    const open = declaration.index + declaration[0].length - 1;
    if (name === undefined || masked[open] !== '(') continue;
    const helper = helperAt(masked, name, open);
    if (helper !== undefined) helpers.push(helper);
  }
  for (const declaration of masked.matchAll(CLASS_DECL)) {
    const name = declaration[1];
    const body = declaration.index + declaration[0].length - 1;
    const inner = bracketSpan(masked, body);
    const found = inner === undefined ? null : CONSTRUCTOR.exec(inner);
    if (name === undefined || found === null) continue;
    const helper = helperAt(masked, name, body + 1 + found.index + found[0].length - 1);
    if (helper !== undefined) helpers.push(helper);
  }
  return helpers;
}

/**
 * A fix argument this scan could not read, at a call site it could: the callee is a known helper
 * and the fix position holds something other than one literal. Counted rather than dropped, so
 * `x verify`'s `errors` step can say "checked 412, could not read 27" — a gate that stays silent
 * about its own blind spot is the false green this file exists to close (axiom 4 applies to it too).
 */
export interface FixScan {
  readonly sites: readonly FixSite[];
  readonly unreadable: number;
}

/**
 * The argument in that position at every call to that helper in this file. `new X(…)` is a call
 * like any other here: the lookbehind sees the space after `new`, so a class needs no second rule.
 */
function helperFixSites(
  masked: string,
  source: string,
  at: string,
  helper: FixHelper,
  lineAt: (index: number) => number,
  unreadable: { count: number },
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
    // A call one argument short passes no fix at all — nothing was written here to read.
    if (argument === undefined) continue;
    // Stricter than the `fix:` path, and deliberately: the whole argument must BE one literal.
    // `valueLiterals` alone reads `prefix + 'x doctor'` as one literal, because the identifier
    // half contributes none — and publishing half a fix as the whole one is the failure
    // `soleLiteral` already names. A key at least declares that what follows is the value.
    const quote = argument.trim()[0];
    if (quote === undefined || !QUOTES.has(quote)) {
      unreadable.count += 1;
      continue;
    }
    const literal = argument.indexOf(quote);
    if (argument.slice(endOfLiteral(argument, literal)).trim() !== '') {
      unreadable.count += 1;
      continue;
    }
    const from = parts.slice(0, helper.index).reduce((n, part) => n + part.length + 1, open + 1);
    const literals = valueLiterals(masked, source, from, lineAt);
    if (literals.length === 1) sites.push({ ...(literals[0] as FixSite), at });
    else unreadable.count += 1;
  }
  return sites;
}

/**
 * The identifier a `fix:` value LOOKS UP, when the value is a lookup and nothing else:
 * `fix: SQLSTATE_FIXES[code]`, `fix: SQLSTATE_FIXES.X_DB_POOL_EXHAUSTED`, and the `.replace(…)`
 * that `@ultimat3/db` puts after the first of those. The value expression then holds NO literal at
 * its own depth, so `valueLiterals` answered `[]` and the site was dropped without being counted —
 * six shipped fix lines that no rule had ever read, and nothing to catch a seventh (#97).
 */
/** A constant's spelling, and the only head whose failure to resolve is worth counting. */
const TABLE_NAME = /^[A-Z][A-Z0-9_]*$/;

const LOOKUP_HEAD = /^\s*([A-Za-z_$][\w$]*)\s*[[.]/;

/** The one wrapper a table is allowed to arrive in. Any other call is a factory, not a table. */
const FREEZE = 'Object.freeze(';

/**
 * Where the object literal bound to `name` opens in this file, or `undefined` when this file does
 * not declare one. One hop and same-file only, deliberately: a table is a `const` a few lines
 * above the factory that reads it in every instance measured here, and following a chain or a
 * second file is where a text scan starts guessing.
 *
 * Conservative in three ways, and each one answers `undefined` so the caller counts the site
 * instead of reading an unrelated object. **A name declared twice is not resolved at all**: this
 * scan tracks no lexical scope, so a nested `const FIXES` would otherwise be read as the outer one
 * and the gate would judge fix lines from a table the call site cannot reach. **Only a bare `{…}`
 * or the exact `Object.freeze({…})`**: `makeTable({…})` is a call whose result this cannot know,
 * and reading its argument would report the input to a factory as the factory's output. **And only
 * a `const`** — a `let` can be reassigned, and the last assignment is what a call reads.
 *
 * `name` is always `LOOKUP_HEAD`'s capture, `[A-Za-z_$][\w$]*`, so it carries no regex
 * metacharacter and the pattern below is linear whatever a source file contains.
 */
function tableOpen(masked: string, name: string): number | undefined {
  const declaration = new RegExp(`(?<![.\\w$])const\\s+${name}\\s*(?::[^=;]*)?=\\s*`, 'g');
  const first = declaration.exec(masked);
  if (first === null || declaration.exec(masked) !== null) return undefined;
  const rest = masked.slice(first.index + first[0].length);
  const value = rest.trimStart();
  const skipped = rest.length - value.length;
  const from = first.index + first[0].length + skipped;
  if (value.startsWith('{')) return from;
  if (!value.startsWith(FREEZE)) return undefined;
  const inner = value.slice(FREEZE.length).trimStart();
  return inner.startsWith('{') ? from + (value.length - inner.length) : undefined;
}

/** Where this entry's value stops: the next `,` at the entry's own depth, or the table's `}`. */
function entryEnd(masked: string, from: number): number {
  let depth = 0;
  for (let i = from; i < masked.length; i += 1) {
    const ch = masked[i] as string;
    if (QUOTES.has(ch)) {
      i = Math.max(i, endOfLiteral(masked, i) - 1);
      continue;
    }
    if (OPENERS.has(ch)) depth += 1;
    else if (CLOSERS.has(ch)) {
      if (depth === 0) return i;
      depth -= 1;
    } else if (depth === 0 && ch === ',') return i;
  }
  return masked.length;
}

/**
 * Every fix string a table holds, read at its entries' own depth. A value that is a concatenation
 * yields one site per literal, exactly as a `fix:` key does — the rule is per line, and half a fix
 * carrying a banned phrase is still a fix line an agent is handed.
 */
function tableFixSites(
  masked: string,
  source: string,
  at: string,
  open: number,
  lineAt: (index: number) => number,
): readonly FixSite[] {
  const sites: FixSite[] = [];
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    const ch = masked[i] as string;
    // A quoted KEY (`'23505': '…'`) is skipped whole, so its closing quote cannot be read as the
    // opener of the value and shift every literal after it by one.
    if (QUOTES.has(ch)) {
      i = Math.max(i, endOfLiteral(masked, i) - 1);
      continue;
    }
    if (OPENERS.has(ch)) depth += 1;
    else if (CLOSERS.has(ch)) {
      depth -= 1;
      if (depth === 0) break;
    } else if (depth === 1 && ch === ':') {
      for (const literal of valueLiterals(masked, source, i + 1, lineAt)) {
        sites.push({ ...literal, at });
      }
      // Past the whole value, because `valueLiterals` already read all of it. A conditional value
      // carries a SECOND colon at this same depth — `a: on ? 'x doctor' : 'x verify'` — and
      // resuming here would read its else branch a second time and report one entry twice.
      i = Math.max(i, entryEnd(masked, i + 1) - 1);
    }
  }
  return sites;
}

/**
 * Every string a `fix:` can evaluate to. Searched over the masked source, so a `fix:` written
 * inside a doc comment or interpolated into a message is not mistaken for a declaration. A `fix`
 * computed at runtime — a bare identifier, a parameter, a table lookup with no literal fallback —
 * has nothing to read and is beyond a static scan; the gate says so rather than guessing.
 *
 * Three shapes, because a fix does not always arrive under a key. `@ultimat3/mcp`'s
 * `readonly-sql.ts` hands every one of its fixes positionally to a local `rejected(cause, fix)`
 * helper, so the key rule alone returned `[]` for the whole file — 20 non-test files in that
 * package and the scanner saw fixes in three — and two stale `x db branch <name>` lines shipped
 * through the hole.
 *
 * `imported` is the third: the helpers this file can call that it did not declare, resolved by
 * `fix-imports.ts` and passed in, because a scanner over one string cannot open a second file.
 * The four rules a call site is read under are `helperAt`'s and do not change with where the
 * declaration was found.
 */
export function scanFixSites(
  source: string,
  at: string,
  imported: readonly FixHelper[] = [],
): FixScan {
  const unreadable = { count: 0 };
  const masked = maskLiterals(source);
  const lineAt = lineIndex(masked);
  const sites: FixSite[] = [];
  const tables = new Set<string>();
  for (const key of masked.matchAll(FIX_KEY)) {
    const start = key.index + key[0].length;
    const literals = valueLiterals(masked, source, start, lineAt);
    for (const literal of literals) sites.push({ ...literal, at });
    // A lookup is recorded whether or not the expression also held a literal: `TABLE[k] ?? 'x'`
    // is two answers and both are fix lines. The NAME is collected rather than the table resolved
    // here, so a table read at four call sites is checked once instead of reported four times.
    const head = LOOKUP_HEAD.exec(masked.slice(start, start + 200))?.[1];
    if (head !== undefined) tables.add(head);
  }
  for (const name of tables) {
    const open = tableOpen(masked, name);
    if (open !== undefined) {
      sites.push(...tableFixSites(masked, source, at, open, lineAt));
      continue;
    }
    // Nothing resolved. `init.fix` is a property of a parameter, already read wherever that
    // parameter was filled, and counting it would make the coverage line describe re-passes rather
    // than blind spots. A SCREAMING_SNAKE head is the one that cannot be that: it names a constant,
    // and a constant this file does not declare is a table in another file — a real hole, and the
    // one shape this scan says out loud instead of dropping.
    if (TABLE_NAME.test(name)) unreadable.count += 1;
  }
  // A name declared here wins over one imported under the same name: the declaration is what a
  // call in this file actually reaches, and reading both would report one argument twice.
  const local = scanFixHelpers(masked);
  const names = new Set(local.map((helper) => helper.name));
  for (const helper of [...local, ...imported.filter((one) => !names.has(one.name))]) {
    sites.push(...helperFixSites(masked, source, at, helper, lineAt, unreadable));
  }
  return { sites, unreadable: unreadable.count };
}

/** The sites alone, for every caller that has no second file to resolve an import against. */
export const scanFixes = (
  source: string,
  at: string,
  imported: readonly FixHelper[] = [],
): readonly FixSite[] => scanFixSites(source, at, imported).sites;
