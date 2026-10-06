#!/usr/bin/env bun
// Enforce, as a ratchet, that a value whose NAME says it is a secret is never compared with an
// operator that stops at the first differing byte: `===`, `!==`, `.includes()`, `.indexOf()`,
// `.startsWith()`, `.endsWith()`, a `switch` over it, or `Bun.deepEquals()`. `timingSafeEqual` from
// `@ultimat3/core` is the one form.
//
// THE OPERATOR SET WAS THE HOLE UNTIL 2026-09-06, and it read as the whole rule. Five spellings
// were green: the two PREFIX tests, which leak more than `===` does because a partial match answers
// true and hands back a length oracle as well as a timing one; `known.indexOf(secret) !== -1`,
// which was not merely unread but DROPPED — the `-1` operand is inert, so the equality scan deleted
// the site on the strength of the half carrying no secret; `switch (secret) { case expected: }`,
// an equality chain whose operator is never written; and `Bun.deepEquals(a, b)`, which is `===`
// with a name in front. `@ultimat3/auth` measured ZERO before and after, which is the point of the
// rule and is why the widening cost four pinned sites and no repair.
//
// WHY IT MUST BE STATIC. `packages/auth/CLAUDE.md` has always said "never `===` on a secret" and
// nothing read that sentence. All twelve `timingSafeEqual` call sites in `@ultimat3/auth` were
// rewritten to `(a) === (b)` and the package answered 432 pass · 14 skip · 0 fail · 446 tests;
// `session.test.ts` passed 24 of 24 with `session.ts:149` degraded, which is the comparison a
// session cookie's whole authenticity rests on. A unit test cannot assert constant time — the
// difference between the two spellings is a timing distribution, not a return value — so a test
// suite is structurally incapable of holding this rule and a text rule is the only thing that can.
//
// WHAT IT READS: the NAME of each operand, never its type. `tokenHash === record.tokenHash` is
// reported; `a === b` is not, and never will be. False positives are PINNED with the sentence
// saying what the value actually is — a search token, a job state, a route path — because narrowing
// the vocabulary to make one finding go away is how the next real one gets through.
// `scripts/lib/secret-compare-pins.ts` is that table, and `@ultimat3/auth` is not in it. PER SITE
// since plan 101 sweep 11 — `<path>: <comparison>` — because a per-package count let a pinned false
// positive be deleted and a real unsafe comparison added in the same package with no number moving.
//
// A TEMPLATE is read for what it interpolates: `` sig === `sha256=${hmac(body)}` `` is a value
// computed at run time, and until sweep 11 its backtick alone made it a constant. `a.equals(b)` and
// `Buffer.compare(a, b)` stop at the first differing byte too, and are read like `deepEquals`.
//
// WHAT IT DOES NOT REPORT, and both were measured rather than guessed: a comparison against an
// INERT operand (`token === null`, `secret.length === 0`, `state === 'running'`), which
// short-circuits on a type tag or reads a constant that is already in the source; and a bare `key`,
// which matches 362 sites and is needed by none of `@ultimat3/auth`'s twelve real comparisons.
//
//   bun run secret-compare  ·  bun run scripts/secret-compare.ts [--json]
//   bun run scripts/secret-compare.ts --unpin <path>[,<path>]   # shrink the ratchet

import { renderFixShellArg } from '../packages/core/src/error-render';
import { maskLiterals } from '../packages/core/src/source-mask';
import type { SourceFile } from './boundaries';
import { balancedClose } from './lib/balanced-paren';
import { corpus } from './lib/corpus';
import type { Finding } from './lib/log';
import type { PinTable, RatchetGap } from './lib/ratchet';
import { ratchetGaps, ratchetMain } from './lib/ratchet';
import type { SiteProbe } from './lib/ratchet-sites';
import { leadSite, newSitesFirst, siteList } from './lib/ratchet-sites';
import {
  isInert,
  namesASecret,
  operandAfter,
  operandBefore,
  predicateElementAt,
} from './lib/secret-compare-operands';
import { SECRET_COMPARE_PINS, SECRET_PINS_FILE } from './lib/secret-compare-pins';
import { isTestPath, lineOf } from './lib/source-scan';
import { withInterpolations } from './lib/template-interpolations';

const SCRIPT = 'secret-compare';
const EXPLAIN = 'bun run scripts/secret-compare.ts --explain --json lists every one';

// The vocabulary and the two operand walks live in `lib/secret-compare-operands.ts` — this file
// reached its 500-line ceiling when it learned the other four comparisons. Re-exported BY NAME so
// the rule stays the one import a caller or a test needs.
export {
  isInert,
  namesASecret,
  operandAfter,
  operandBefore,
  SECRET_SUFFIXES,
  SECRET_WORDS,
} from './lib/secret-compare-operands';

export type SecretCompareKind =
  | 'equality'
  | 'includes'
  | 'prefix'
  | 'switch'
  | 'deep-equal'
  | 'buffer-equal';

export interface SecretCompareSite {
  readonly path: string;
  readonly line: number;
  readonly kind: SecretCompareKind;
  /** The identifier that put this site in the report. */
  readonly name: string;
  /** The comparison, as source, for the finding to quote back. */
  readonly source: string;
}

const EQUALITY = /!==|===/g;

/**
 * The MEMBERSHIP forms, all four of which stop at the first differing byte.
 *
 * `.includes(` was the only one this rule read until 2026-09-06, and the other three are not
 * variations on it — two of them leak MORE. `startsWith`/`endsWith` answer true on a PARTIAL match,
 * so they hand back a length-independent oracle on top of the timing one; and `.indexOf(secret)`
 * was worse than unread, it was DROPPED: the comparison a caller writes is
 * `known.indexOf(secret) !== -1`, whose `-1` operand is inert, so the equality scan below deleted
 * the site on the strength of the half that carries no secret.
 */
const MEMBERSHIP: readonly (readonly [RegExp, SecretCompareKind])[] = [
  [/\.includes\s*\(/g, 'includes'],
  [/\.indexOf\s*\(/g, 'includes'],
  [/\.startsWith\s*\(/g, 'prefix'],
  [/\.endsWith\s*\(/g, 'prefix'],
];

/**
 * `switch (secret) { case expected: }` — an equality chain the `===` scan cannot see, because the
 * operator is never written. A `case` against a string LITERAL is inert for exactly the reason
 * `state === 'running'` is: the constant is already in the source.
 */
const SWITCH = /\bswitch\s*\(/g;
const CASE = /\bcase\s+([^:\n]+):/g;

/**
 * `Bun.deepEquals(a, b)` and a bare imported `deepEquals(a, b)`. It walks both values and returns
 * at the first difference, which is `===` with a name in front — and the receiver is not what is
 * matched, for the reason this rule refuses to key on names anywhere else.
 */
const DEEP_EQUAL = /(?<![\w$.])(?:Bun\s*\.\s*)?deepEquals\s*\(/g;

/**
 * `Buffer.compare(a, b)` — a byte-order sort that returns at the first differing byte, which is
 * the same oracle `===` is. Its instance sibling `a.equals(b)` is below, with `.equals(`.
 */
const BUFFER_COMPARE = /(?<![\w$.])Buffer\s*\.\s*compare\s*\(/g;

/** The two-argument comparisons, each read on every argument. */
const CALLS: readonly (readonly [RegExp, SecretCompareKind])[] = [
  [DEEP_EQUAL, 'deep-equal'],
  [BUFFER_COMPARE, 'buffer-equal'],
];

/**
 * `a.equals(b)` — `Buffer#equals`, `Uint8Array`-alike `equals`: a byte loop that stops at the
 * first difference. SYMMETRIC, like a prefix test: the secret may be either the receiver or the
 * argument, and `timingSafeEqual` takes both in either order.
 */
const EQUALS = /\.equals\s*\(/g;

/** One call's arguments, split on TOP-LEVEL commas. */
const argumentsOf = (inner: string): readonly string[] => {
  const args: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    else if (char === ',' && depth === 0) {
      args.push(inner.slice(start, index).trim());
      start = index + 1;
    }
  }
  args.push(inner.slice(start).trim());
  return args;
};

/** The `}` matching the first `{` at or after `from`, or `-1`. */
const closingBrace = (code: string, from: number): number => {
  const open = code.indexOf('{', from);
  if (open === -1) return -1;
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    if (code[index] === '{') depth += 1;
    else if (code[index] === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
};

/**
 * Every name-a-secret comparison in one file, in source order.
 *
 * Read from `maskLiterals`' output — a string's contents blanked, every offset preserved — so a
 * scaffold template that EMITS `token === expected` inside a template literal is not read as this
 * file's own comparison. `@ultimat3/cli`'s templates emit app source that way.
 */
export function scanSecretCompares(
  path: string,
  source: string,
  masked: string = maskLiterals(source),
): readonly SecretCompareSite[] {
  // A `${…}` body is code that runs: read it, never the template's static text.
  const code = withInterpolations(source, masked);
  const sites: SecretCompareSite[] = [];
  const elementAt = predicateElementAt(code);
  for (const match of code.matchAll(EQUALITY)) {
    const at = match.index;
    const left = operandBefore(code, at);
    const right = operandAfter(code, at + match[0].length);
    if (isInert(left) || isInert(right)) continue;
    const element = elementAt(at);
    const name = namesASecret(left, element) ?? namesASecret(right, element);
    if (name === undefined) continue;
    sites.push({
      path,
      line: lineOf(code, at),
      kind: 'equality',
      name,
      source: `${left} ${match[0]} ${right}`.trim(),
    });
  }
  for (const [pattern, kind] of MEMBERSHIP) {
    for (const match of code.matchAll(pattern)) {
      const at = match.index;
      const receiver = operandBefore(code, at);
      const argument = operandAfter(code, at + match[0].length);
      // The RECEIVER alone is never enough for `includes`/`indexOf`: `KNOWN_ROLES.includes(role)`
      // is a membership test on a public list, and the ARGUMENT is the value whose secrecy is at
      // stake. A PREFIX test is symmetric — `sessionToken.startsWith(given)` puts the secret on the
      // receiver — so both sides are read there and only there.
      if (isInert(argument) || isInert(receiver)) continue;
      const element = elementAt(at);
      const name =
        kind === 'prefix'
          ? (namesASecret(argument, element) ?? namesASecret(receiver, element))
          : namesASecret(argument, element);
      if (name === undefined) continue;
      sites.push({
        path,
        line: lineOf(code, at),
        kind,
        name,
        source: `${receiver}${match[0].trim()}${argument})`,
      });
    }
  }
  for (const match of code.matchAll(SWITCH)) {
    const open = match.index + match[0].length - 1;
    const close = balancedClose(code, open);
    if (close === -1) continue;
    const discriminant = code.slice(open + 1, close).trim();
    if (isInert(discriminant)) continue;
    const name = namesASecret(discriminant);
    if (name === undefined) continue;
    const end = closingBrace(code, close);
    if (end === -1) continue;
    for (const one of code.slice(close, end).matchAll(CASE)) {
      const label = (one[1] as string).trim();
      if (isInert(label)) continue;
      sites.push({
        path,
        line: lineOf(code, close + one.index),
        kind: 'switch',
        name,
        source: `switch (${discriminant}) { case ${label}: }`,
      });
    }
  }
  for (const [pattern, kind] of CALLS) {
    for (const match of code.matchAll(pattern)) {
      const open = match.index + match[0].length - 1;
      const close = balancedClose(code, open);
      if (close === -1) continue;
      const args = argumentsOf(code.slice(open + 1, close)).filter((one) => !isInert(one));
      const name = args.map((one) => namesASecret(one)).find((one) => one !== undefined);
      if (name === undefined) continue;
      sites.push({
        path,
        line: lineOf(code, match.index),
        kind,
        name,
        source: `${match[0].replace(/\s+/g, '')}${args.join(', ')})`,
      });
    }
  }
  for (const match of code.matchAll(EQUALS)) {
    const receiver = operandBefore(code, match.index);
    const argument = operandAfter(code, match.index + match[0].length);
    if (isInert(receiver) || isInert(argument)) continue;
    const element = elementAt(match.index);
    const name = namesASecret(argument, element) ?? namesASecret(receiver, element);
    if (name === undefined) continue;
    sites.push({
      path,
      line: lineOf(code, match.index),
      kind: 'buffer-equal',
      name,
      source: `${receiver}.equals(${argument})`,
    });
  }
  return sites.sort((a, b) => a.line - b.line);
}

export type SecretCompareGap = RatchetGap<SecretCompareSite>;

/**
 * The pin row a site answers to: its file and the comparison as the rule quotes it, whitespace
 * squeezed so a Biome rewrap is the same row. Never its line — an edit above it moves that.
 */
export const secretCompareSiteKey = (site: SecretCompareSite): string =>
  `${site.path}: ${site.source.replace(/\s+/g, ' ').trim()}`;

/** `--unpin <path>` names every row of that file. */
export const secretCompareUnpinRows = (name: string, pins: PinTable): readonly string[] =>
  Object.keys(pins).filter((key) => key === name || key.startsWith(`${name}: `));

export interface SecretCompareInput {
  readonly files: readonly SourceFile[];
  readonly pins: PinTable;
}

/** The ratchet over fixture files: a package may hold what it is pinned at, may fall, never rise. */
export const checkSecretCompares = (input: SecretCompareInput): readonly SecretCompareGap[] =>
  ratchetGaps(
    input.files.flatMap((file) =>
      isTestPath(file.path)
        ? []
        : scanSecretCompares(file.path, file.source, maskLiterals(file.source)),
    ),
    input.pins,
    input.files.length > 0,
    secretCompareSiteKey,
  );

/** The file a site row names: everything before the first `: `. */
const fileOf = (key: string): string => key.slice(0, Math.max(0, key.indexOf(': '))) || key;

const at = (site: SecretCompareSite | undefined): string =>
  site === undefined ? '' : `${site.path}:${String(site.line)}`;

/**
 * One row's comparisons over its count. The row is ONE site, so the fix names it outright: the
 * copies the cause lists are the same comparison, and the one this change added is among them.
 */
const overFinding = (gap: SecretCompareGap): Finding => {
  const listed = siteList(gap, (site) => `${at(site)} \`${site.source}\``, EXPLAIN);
  const lead = leadSite(gap);
  const named = lead === undefined ? 'the value' : `"${lead.name}"`;
  const row =
    gap.pinned === 0
      ? `add the row '${gap.pkg}': { count: ${String(gap.found)}, reason: '<what ${named} is>' } to SECRET_COMPARE_PINS in ${SECRET_PINS_FILE}`
      : `raise the row '${gap.pkg}' in ${SECRET_PINS_FILE} to ${String(gap.found)} with a // why: on it`;
  return {
    code: 'X_SECRET_COMPARED_UNSAFELY',
    cause: `${gap.pkg} — a value named as a secret compared with a short-circuiting operator in ${String(gap.found)} place(s), pinned at ${String(gap.pinned)} — ${listed} — whose running time depends on how many leading bytes match, so an attacker learns the value one byte at a time`,
    fix: `replace the comparison at ${at(lead)} with timingSafeEqual(a, b) from @ultimat3/core; if ${named} is not a secret, ${row}`,
    at: at(lead),
  };
};

const staleFinding = (gap: SecretCompareGap): Finding => ({
  code: 'X_SECRET_COMPARE_PIN_STALE',
  cause: `the row '${gap.pkg}' is pinned at ${String(gap.pinned)} comparison(s) and the tree has ${String(gap.found)} — the row is above what this tree contains, so it would let ${String(gap.pinned - gap.found)} back in`,
  fix: `bun run scripts/secret-compare.ts --unpin ${renderFixShellArg(fileOf(gap.pkg), '<the file the row names>')}`,
  at: SECRET_PINS_FILE,
});

const unexplainedFinding = (gap: SecretCompareGap): Finding => ({
  code: 'X_SECRET_COMPARE_PIN_UNEXPLAINED',
  cause: `the row '${gap.pkg}' is pinned with a blank reason, so nothing records what its ${String(gap.found)} comparison(s) really compare — a count with no sentence is the waiver this table exists to refuse, and the pin holds nothing`,
  fix: `write what the value at '${gap.pkg}' actually is — a search token, a job state, a route path — in ${SECRET_PINS_FILE}; or replace the comparison with timingSafeEqual(a, b) from @ultimat3/core and run bun run scripts/secret-compare.ts --unpin ${renderFixShellArg(fileOf(gap.pkg), '<the file the row names>')}`,
  at: SECRET_PINS_FILE,
});

const unscannedFinding = (): Finding => ({
  code: 'X_SECRET_COMPARE_UNSCANNED',
  cause:
    'no source file was read, so every package reports zero and the ratchet enforces nothing — a glob that matches nothing reads exactly like a tree with no unsafe comparison in it',
  fix: 'edit PATTERNS in scripts/lib/corpus.ts so it matches this repo layout, then bun run scripts/secret-compare.ts',
  at: 'scripts/lib/corpus.ts',
});

export const secretCompareFindingFor = (gap: SecretCompareGap): Finding =>
  gap.kind === 'over'
    ? overFinding(gap)
    : gap.kind === 'stale'
      ? staleFinding(gap)
      : gap.kind === 'unexplained'
        ? unexplainedFinding(gap)
        : unscannedFinding();

/** Every site in the tree, read off the shared corpus and its cached mask. */
export const secretCompareSites = async (root: string): Promise<readonly SecretCompareSite[]> =>
  (await corpus(root, 'source')).flatMap((file) =>
    isTestPath(file.path) ? [] : scanSecretCompares(file.path, file.source, file.masked),
  );

const PROBE: SiteProbe<SecretCompareSite> = {
  rescan: (path, source) => scanSecretCompares(path, source),
  line: (site) => site.line,
};

export const secretCompareGaps = async (root: string): Promise<readonly SecretCompareGap[]> =>
  newSitesFirst(
    root,
    ratchetGaps(await secretCompareSites(root), SECRET_COMPARE_PINS, true, secretCompareSiteKey),
    PROBE,
  );

/** What this rule contributes to `x verify`, through its own test file. */
export const secretCompareFindings = async (root: string): Promise<readonly Finding[]> =>
  (await secretCompareGaps(root)).map(secretCompareFindingFor);

if (import.meta.main) {
  await ratchetMain({
    script: SCRIPT,
    pinsFile: SECRET_PINS_FILE,
    pins: SECRET_COMPARE_PINS,
    sites: secretCompareSites,
    findingFor: secretCompareFindingFor,
    probe: PROBE,
    groupOf: secretCompareSiteKey,
    unpinRows: secretCompareUnpinRows,
    clean:
      'no secret-named value is compared with ===, !==, .includes(), .indexOf(), a prefix test, a switch, deepEquals, .equals() or Buffer.compare() outside a pinned site',
  });
}
