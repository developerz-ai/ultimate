#!/usr/bin/env bun
// Enforce, as a ratchet, that a value whose NAME says it is a secret is never compared with `===`,
// `!==` or `.includes()`. `timingSafeEqual` from `@ultimat3/core` is the one form.
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
// `scripts/lib/secret-compare-pins.ts` is that table, 53 sites across 14 packages on day one, and
// `@ultimat3/auth` is not one of them.
//
// WHAT IT DOES NOT REPORT, and both were measured rather than guessed: a comparison against an
// INERT operand (`token === null`, `secret.length === 0`, `state === 'running'`), which
// short-circuits on a type tag or reads a constant that is already in the source; and a bare `key`,
// which matches 362 sites and is needed by none of `@ultimat3/auth`'s twelve real comparisons.
//
//   bun run secret-compare  ·  bun run scripts/secret-compare.ts [--json]
//   bun run scripts/secret-compare.ts --unpin <pkg>[,<pkg>]   # shrink the ratchet

import { maskLiterals } from '@ultimat3/cli';
import { collectSourceFiles, type SourceFile } from './boundaries';
import { flagList, parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import {
  applySecretCompareUnpin,
  SECRET_COMPARE_PINS,
  SECRET_PINS_FILE,
  secretComparePinnedFor,
} from './lib/secret-compare-pins';
import { isTestPath, lineOf } from './lib/source-scan';
import { packageOf } from './test-fix-citations';

const SCRIPT = 'secret-compare';

/**
 * The camelCase SUFFIXES that make a comparison a credential check: `tokenHash`, `keyHash`,
 * `csrfToken`, `apiKey` and `mfaSecret` are each one of these wearing a prefix.
 */
export const SECRET_SUFFIXES: readonly string[] = [
  'Hash',
  'Secret',
  'Token',
  'Key',
  'Nonce',
  'Digest',
  'Mac',
  'Signature',
  'Verifier',
  'Candidate',
];

/**
 * The bare words, whole and case-insensitive. `state` is here because `oauth.ts:131` compares the
 * OAuth handshake `state` under that exact name; `candidate` and `digest` because `mfa.ts` calls a
 * recovery code and its hash that.
 */
export const SECRET_WORDS: readonly string[] = [
  'hash',
  'secret',
  'token',
  'nonce',
  'verifier',
  'signature',
  'candidate',
  'digest',
  'mac',
  'state',
];

/**
 * `tokenHash` yes, `sortKey` yes, `key` NO.
 *
 * The camelCase SUFFIX and the whole WORD, and deliberately not "contains `key`": measured, a bare
 * `key` matches 362 sites across 27 packages — a `Map` key, a sort key, a cache key, a catalog key
 * — and not one of `@ultimat3/auth`'s twelve `timingSafeEqual` call sites needs it. `keyHash` and
 * `apiKey` carry the capital. A vocabulary that reds a whole tree is a vocabulary somebody deletes,
 * and this rule only has to be narrow enough to survive.
 */
const SECRET_NAME = new RegExp(
  `(?:${SECRET_SUFFIXES.join('|')})$|^(?:${SECRET_WORDS.join('|')})s?$`,
  '',
);

/** Every identifier in an operand's text — `sha256Hex(parsed.secret)` gives three. */
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;

export const namesASecret = (operand: string): string | undefined =>
  [...operand.matchAll(IDENTIFIER)].map((one) => one[0]).find((name) => SECRET_NAME.test(name));

/**
 * An operand that carries no secret bytes, so the comparison against it leaks nothing: `undefined`,
 * `null`, a boolean, a number, a string LITERAL, or a `.length`.
 *
 * This is what separates a PRESENCE check from a credential check, and it is most of the difference
 * between a rule and a wall. Measured: without it 241 sites report across 25 packages and 32 of
 * them are in `@ultimat3/auth`, whose twelve real comparisons all already go through
 * `timingSafeEqual` — `if (token === null)`, `secret.length === 0`, `user.mfaSecret !== null`.
 * `x === undefined` cannot be walked byte by byte because there is no byte to walk: the operator
 * short-circuits on the type tag before any content is read.
 *
 * A string literal is read off `maskLiterals`' output, where the contents are blanked and the
 * QUOTES survive — which is exactly the property that makes `state === '     '` recognisable as a
 * comparison against a constant without this rule ever seeing what the constant said.
 */
const INERT = /^(?:undefined|null|true|false|-?\d|['"`])|\.length$/;

export const isInert = (operand: string): boolean => {
  const text = operand.trim();
  // EMPTY is inert, and it is the commonest case by far: the walk stops at the first character it
  // does not recognise, and a masked string literal opens with a quote — so `secret === ''` and
  // `typeof state !== 'string'` both hand back nothing on one side. Reading "unreadable" as
  // "suspicious" reported 100 comparisons against a constant, `record.state === 'running'` among
  // them. A literal is in the source; there is nothing to learn a byte at a time.
  return text === '' || INERT.test(text);
};

const CLOSERS: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' };
const OPENERS: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}' };

/** Backwards over one primary expression: identifiers, `.`, `?.`, and balanced `(…)` / `[…]`. */
export function operandBefore(code: string, at: number): string {
  let index = at - 1;
  while (index >= 0 && /\s/.test(code[index] as string)) index -= 1;
  const end = index + 1;
  while (index >= 0) {
    const char = code[index] as string;
    if (Object.hasOwn(CLOSERS, char)) {
      const open = CLOSERS[char] as string;
      let depth = 0;
      for (; index >= 0; index -= 1) {
        const inner = code[index] as string;
        if (inner === char) depth += 1;
        else if (inner === open) {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      index -= 1;
      continue;
    }
    if (/[\w$.?!]/.test(char)) {
      index -= 1;
      continue;
    }
    break;
  }
  return code.slice(index + 1, end);
}

/** Forwards over one primary expression, the mirror of the walk above. */
export function operandAfter(code: string, from: number): string {
  let index = from;
  while (index < code.length && /\s/.test(code[index] as string)) index += 1;
  const start = index;
  while (index < code.length) {
    const char = code[index] as string;
    if (Object.hasOwn(OPENERS, char)) {
      const close = OPENERS[char] as string;
      let depth = 0;
      for (; index < code.length; index += 1) {
        const inner = code[index] as string;
        if (inner === char) depth += 1;
        else if (inner === close) {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      index += 1;
      continue;
    }
    if (/[\w$.?!]/.test(char)) {
      index += 1;
      continue;
    }
    break;
  }
  return code.slice(start, index);
}

export type SecretCompareKind = 'equality' | 'includes';

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
const INCLUDES = /\.includes\s*\(/g;

/**
 * Every name-a-secret comparison in one file, in source order.
 *
 * Read from `maskLiterals`' output — a string's contents blanked, every offset preserved — so a
 * scaffold template that EMITS `token === expected` inside a template literal is not read as this
 * file's own comparison. `@ultimat3/cli`'s templates emit app source that way.
 */
export function scanSecretCompares(path: string, source: string): readonly SecretCompareSite[] {
  const code = maskLiterals(source);
  const sites: SecretCompareSite[] = [];
  for (const match of code.matchAll(EQUALITY)) {
    const at = match.index;
    const left = operandBefore(code, at);
    const right = operandAfter(code, at + match[0].length);
    if (isInert(left) || isInert(right)) continue;
    const name = namesASecret(left) ?? namesASecret(right);
    if (name === undefined) continue;
    sites.push({
      path,
      line: lineOf(code, at),
      kind: 'equality',
      name,
      source: `${left} ${match[0]} ${right}`.trim(),
    });
  }
  for (const match of code.matchAll(INCLUDES)) {
    const at = match.index;
    const receiver = operandBefore(code, at);
    const argument = operandAfter(code, at + match[0].length);
    // The RECEIVER alone is never enough: `KNOWN_ROLES.includes(role)` is a membership test on a
    // public list. The ARGUMENT is the value whose secrecy is at stake.
    if (isInert(argument) || isInert(receiver)) continue;
    const name = namesASecret(argument);
    if (name === undefined) continue;
    sites.push({
      path,
      line: lineOf(code, at),
      kind: 'includes',
      name,
      source: `${receiver}.includes(${argument})`,
    });
  }
  return sites.sort((a, b) => a.line - b.line);
}

export type SecretCompareGapKind = 'over' | 'stale' | 'unscanned';

export interface SecretCompareGap {
  readonly kind: SecretCompareGapKind;
  readonly pkg: string;
  readonly found: number;
  readonly pinned: number;
  readonly first?: SecretCompareSite;
}

export interface SecretCompareInput {
  readonly files: readonly SourceFile[];
  readonly pins: Readonly<Record<string, { readonly count: number; readonly reason: string }>>;
}

/** The ratchet: a package may hold what it is pinned at, may fall, may never rise. */
export function checkSecretCompares(input: SecretCompareInput): readonly SecretCompareGap[] {
  if (input.files.length === 0) {
    return [{ kind: 'unscanned', pkg: '', found: 0, pinned: 0 }];
  }
  const found = new Map<string, SecretCompareSite[]>();
  for (const file of input.files) {
    if (isTestPath(file.path)) continue;
    for (const site of scanSecretCompares(file.path, file.source)) {
      const pkg = packageOf(site.path);
      const list = found.get(pkg) ?? [];
      list.push(site);
      found.set(pkg, list);
    }
  }
  const gaps: SecretCompareGap[] = [];
  for (const pkg of new Set([...found.keys(), ...Object.keys(input.pins)])) {
    const hits = found.get(pkg) ?? [];
    const pinned = secretComparePinnedFor(pkg, input.pins);
    if (hits.length > pinned) {
      gaps.push({
        kind: 'over',
        pkg,
        found: hits.length,
        pinned,
        ...(hits[0] === undefined ? {} : { first: hits[0] }),
      });
      continue;
    }
    if (hits.length < pinned) gaps.push({ kind: 'stale', pkg, found: hits.length, pinned });
  }
  return gaps.sort((a, b) => (a.pkg < b.pkg ? -1 : a.pkg > b.pkg ? 1 : 0));
}

const at = (site: SecretCompareSite | undefined): string =>
  site === undefined ? '' : `${site.path}:${String(site.line)}`;

const overFinding = (gap: SecretCompareGap): Finding => ({
  code: 'X_SECRET_COMPARED_UNSAFELY',
  cause: `${gap.pkg} compares a value named as a secret with a short-circuiting operator in ${String(gap.found)} place(s) and is pinned at ${String(gap.pinned)} — ${at(gap.first)} writes \`${gap.first?.source ?? ''}\`, whose running time depends on how many leading bytes match, so an attacker learns the value one byte at a time`,
  fix: `replace the comparison at ${at(gap.first)} with timingSafeEqual(a, b) from @ultimat3/core; if "${gap.first?.name ?? ''}" is not a secret, add ${gap.pkg} to SECRET_COMPARE_PINS in ${SECRET_PINS_FILE} with the sentence saying what it is`,
  at: at(gap.first),
});

const staleFinding = (gap: SecretCompareGap): Finding => ({
  code: 'X_SECRET_COMPARE_PIN_STALE',
  cause: `${gap.pkg} is pinned at ${String(gap.pinned)} secret-named comparison(s) and has ${String(gap.found)} — the pin is above what this tree contains, so it would let ${String(gap.pinned - gap.found)} back in`,
  fix: `bun run scripts/secret-compare.ts --unpin ${gap.pkg}`,
  at: SECRET_PINS_FILE,
});

const unscannedFinding = (): Finding => ({
  code: 'X_SECRET_COMPARE_UNSCANNED',
  cause:
    'no source file was read, so every package reports zero and the ratchet enforces nothing — a glob that matches nothing reads exactly like a tree with no unsafe comparison in it',
  fix: 'edit SOURCE_PATTERNS in scripts/boundaries.ts so it matches this repo layout, then bun run scripts/secret-compare.ts',
  at: 'scripts/boundaries.ts',
});

const FINDINGS: Readonly<Record<SecretCompareGapKind, (gap: SecretCompareGap) => Finding>> = {
  over: overFinding,
  stale: staleFinding,
  unscanned: unscannedFinding,
};

export const secretCompareFindingFor = (gap: SecretCompareGap): Finding => FINDINGS[gap.kind](gap);

export const secretCompareGaps = async (root: string): Promise<readonly SecretCompareGap[]> =>
  checkSecretCompares({ files: await collectSourceFiles(root), pins: SECRET_COMPARE_PINS });

/** What this rule contributes to `x verify`'s `unit` step, through `secret-compare.test.ts`. */
export const secretCompareFindings = async (root: string): Promise<readonly Finding[]> =>
  (await secretCompareGaps(root)).map(secretCompareFindingFor);

/** Every site per package, for `--unpin` and for the number a maintainer wants when lowering one. */
export async function secretCompareCounts(root: string): Promise<Readonly<Record<string, number>>> {
  const counts: Record<string, number> = {};
  for (const file of await collectSourceFiles(root)) {
    if (isTestPath(file.path)) continue;
    for (const site of scanSecretCompares(file.path, file.source)) {
      counts[packageOf(site.path)] = (counts[packageOf(site.path)] ?? 0) + 1;
    }
  }
  return counts;
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const unpin = flagList(args, 'unpin');
  if (unpin.length > 0) {
    const lowered = await applySecretCompareUnpin(root, unpin, await secretCompareCounts(root));
    report(
      {
        ok: true,
        script: SCRIPT,
        summary:
          lowered.length === 0
            ? 'nothing to lower — every named package is already at what this tree measures'
            : `lowered ${String(lowered.length)} pin(s): ${lowered.join(', ')}`,
        findings: [],
      },
      args.json,
    );
  } else {
    const gaps = await secretCompareGaps(root);
    report(
      {
        ok: gaps.length === 0,
        script: SCRIPT,
        summary:
          gaps.length === 0
            ? 'no package compares a secret-named value with === , !== or .includes() above its pin'
            : `${String(gaps.length)} package(s) off the secret-comparison ratchet`,
        findings: gaps.map(secretCompareFindingFor),
        data: { counts: await secretCompareCounts(root) },
      },
      args.json,
    );
  }
}
