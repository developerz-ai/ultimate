#!/usr/bin/env bun
// Refuse an ordering assertion built on `indexOf`/`findIndex` with nothing asserting the needle is
// PRESENT — the shape of a test that cannot fail.
//
// THE DEFECT THIS EXISTS FOR. `indexOf` answers `-1` for a needle it never found, and `-1` is less
// than every real index. So
//
//   expect(up.indexOf('drop constraint "…"')).toBeLessThan(Math.min(...alters));
//
// passes when the `drop constraint` is not emitted AT ALL. Measured 2026-08-26 in
// `packages/db/src/retype-keys.test.ts`: deleting the drop from `moveKeysAside` left that
// assertion GREEN. A sweep of `packages/db` then found FIVE more unguarded assertions and one
// unguarded `slice` bound, where a `-1` lower bound silently widens the window instead of failing.
// One instance is a bug; six is a defect class, which is what this file is for.
//
// WHICH OPERAND IS AT RISK IS THE WHOLE RULE, and it is not symmetric:
//
//   X.toBeLessThan(Y)      -> a phantom -1 in **X** passes.  X is at risk.
//   X.toBeGreaterThan(Y)   -> a phantom -1 in **Y** passes.  Y is at risk.
//
// A `-1` on the safe side FAILS, loudly, which is why half the sites in this tree need nothing.
// Reporting those would make the rule noise and get it switched off.
//
// WHAT IT CANNOT RESOLVE. A needle that is an IDENTIFIER rather than a string literal —
// `expect(css).toContain(GLOBAL_CSS)` guarding `css.indexOf(GLOBAL_CSS)` — is only matched when
// the two are spelled identically; the rule does not evaluate the constant. That direction is
// safe (it over-reports, never under-reports), and the repair is the literal beside it.
//
// WHAT COUNTS AS A GUARD. Anything in the same test body that proves the needle is there:
// `toBeGreaterThanOrEqual(0)`, `toBeGreaterThan(-1)`, `not.toBe(-1)`, `toBe(<a literal index>)`,
// or a `toContain(<the same needle>)` on the haystack — which is the spelling this repo reaches
// for most, and the one `generate-drop-order.test.ts` now writes above every comparison.
//
// Both `indexOf` and `findIndex` are read — `findIndex` answers -1 identically, and
// `migrate-lock.test.ts` uses it as an ordering bound.
//
//   bun run index-of-order  ·  bun run scripts/index-of-order.ts [--json] [--explain]
//   bun run scripts/index-of-order.ts --unpin <pkg>[,<pkg>]   # shrink the ratchet

import { parseScriptArgs } from './lib/args';
import { INDEX_OF_ORDER_PINS, type OrderPin } from './lib/index-of-order-pins';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

const SCRIPT = 'index-of-order';

/**
 * Every tree a test can live in, listed one per entry.
 *
 * `Bun.Glob` DOES expand braces — but an alternative containing a `/` matches **zero files**:
 * measured, `{packages,scripts}/**` finds 1,309 and `{packages/<any>/src,scripts}` finds none.
 * A pattern that matches nothing reads exactly like a clean tree, which is how the first draft of
 * this rule reported "0 at-risk sites" having scanned no file at all. One pattern per entry needs
 * no such judgement.
 */
const TEST_GLOBS = [
  'packages/*/src/**/*.test.ts',
  'scripts/**/*.test.ts',
  'examples/**/*.test.ts',
  'dummy/**/*.test.ts',
] as const;

const FROM_INDEX = /\b(?:indexOf|findIndex)\s*\(/;

/** A presence assertion, in any spelling this tree uses. */
const GUARDS = [
  /^\s*\.\s*toBeGreaterThanOrEqual\s*\(\s*0\s*\)/,
  /^\s*\.\s*toBeGreaterThan\s*\(\s*-1\s*\)/,
  /^\s*\.\s*not\s*\.\s*toBe\s*\(\s*-1\s*\)/,
  /^\s*\.\s*toBe\s*\(\s*\d+\s*\)/,
] as const;

export interface OrderSite {
  readonly file: string;
  readonly line: number;
  readonly matcher: 'toBeLessThan' | 'toBeGreaterThan';
  /** The operand a phantom `-1` would make pass. */
  readonly risky: string;
  readonly guarded: boolean;
}

/**
 * The index of the `)` closing the `(` at `open`, skipping string bodies.
 *
 * A regex cannot do this: `expect(up.indexOf('x')).toBeLessThan(…)` has a nested `)`, and a
 * non-greedy group stops at the inner one — the first draft of this rule matched nothing at all
 * and read as a clean tree.
 */
function balanced(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return i;
    } else if (c === '/' && src[i + 1] === '/') {
      // A COMMENT is not code, and this tree's comments are full of backticks — `indexOf`,
      // `BEGIN`. Read as a template literal, one swallowed the rest of the scan and the enclosing
      // test came back empty, so a correctly guarded site read as unguarded. `sql-scan.ts` records
      // the same lesson for SQL: source order, never a sequence of replacements.
      const end = src.indexOf('\n', i);
      if (end < 0) return -1;
      i = end;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) return -1;
      i = end + 1;
    } else if (c === "'" || c === '"' || c === '`') {
      i += 1;
      while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
    }
  }
  return -1;
}

/** The body of the `test(`/`it(` containing `at`, or the whole file when it sits outside one. */
function enclosingTest(src: string, at: number): string {
  // Bounded by INDENTATION, not by paren-balancing the whole test call. Balancing works for one
  // expression and is the right tool there, but over a 200-line body any regex literal or stray
  // quote derails it — and a derailed scan returns nothing, which reads as "no guard here" and
  // reports a correctly guarded site. Indentation is what actually delimits a `test(` block in
  // this tree, and it degrades gracefully.
  const lines = src.split('\n');
  const atLine = src.slice(0, at).split('\n').length - 1;
  const opener = /^(\s*)(?:test|it)(?:\.[A-Za-z]+)*\s*\(/;
  let first = -1;
  let indent = '';
  for (let i = atLine; i >= 0; i -= 1) {
    const m = opener.exec(lines[i] ?? '');
    if (m !== null) {
      first = i;
      indent = m[1] ?? '';
      break;
    }
  }
  // No enclosing test means no body to search: answer the empty string so nothing reads as a
  // guard. Over-reporting is the safe direction; returning the whole FILE is not — a guard in an
  // unrelated test then marks this assertion guarded, which is a false negative.
  if (first < 0) return '';
  let last = lines.length;
  for (let i = first + 1; i < lines.length; i += 1) {
    const text = lines[i] ?? '';
    if (text.trim() === '') continue;
    const lead = /^\s*/.exec(text)?.[0] ?? '';
    if (lead.length <= indent.length) {
      last = i;
      break;
    }
  }
  return last > atLine ? lines.slice(first, last).join('\n') : '';
}

/**
 * The expression whose `-1` would pass — normalised, so a guard on the SAME thing can be matched.
 *
 * `GUARDS.some(...)` over the whole body never bound to it, so an unrelated `expect(res.status)
 * .toBe(200)` satisfied `/\.toBe\(\d+\)/` and silenced the rule. A guard has to be about this
 * index, not merely present nearby.
 */
function normalised(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Whether the body asserts THIS index expression is a real position. */
function guardsExpression(body: string, expression: string): boolean {
  const wanted = normalised(expression);
  for (const m of body.matchAll(/\bexpect\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = balanced(body, open);
    if (close < 0) continue;
    if (normalised(body.slice(open + 1, close)) !== wanted) continue;
    const tail = body.slice(close + 1, close + 60);
    if (GUARDS.some((guard) => guard.test(tail))) return true;
  }
  return false;
}

/**
 * The text of a single-quoted, double-quoted or backtick string literal, or `undefined` for an
 * expression. Only the whole operand — a needle built by concatenation is not a literal and is
 * left to the explicit `>= 0` form.
 */
function literalOf(text: string): string | undefined {
  const m = /^\s*(['"`])([\s\S]*)\1\s*$/.exec(text);
  return m?.[2];
}

/**
 * Whether the test body proves this needle is present.
 *
 * A `toContain` of a SUPERSTRING counts, and that case is the common one rather than an edge:
 * `check-ddl.test.ts` asserts the whole statement and then orders on a fragment of it, which is
 * strictly stronger than asserting the fragment. Comparing the two spellings literally reported it
 * as unguarded — the rule's own false positive, found by running it against a site a manual sweep
 * had already cleared.
 */
function containsNeedle(body: string, needle: string): boolean {
  if (body.includes(`toContain(${needle}`)) return true;
  // `expect(names[0]).toBe('db migrate (empty)')` proves the value is in the haystack just as
  // totally as an index assertion does — the value-at-index spelling, the mirror of `toBe(0)`
  // which `GUARDS` already carries. Flagged at `scripts/scaffold-first-run.test.ts` without it.
  if (body.includes(`toBe(${needle})`)) return true;
  // `expect(BODY.split('return false').length - 1).toBe(1)` is a presence proof STRONGER than
  // `toContain`: it pins the exact number of occurrences. Two sites in this tree spell it that
  // way, and both read as unguarded until the rule learned it.
  if (body.includes(`split(${needle})`) && /\.toBe\s*\(\s*[1-9]\d*\s*\)/.test(body)) return true;
  const wanted = literalOf(needle);
  if (wanted === undefined || wanted === '') return false;
  for (const m of body.matchAll(/\.toContain\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = balanced(body, open);
    if (close < 0) continue;
    const asserted = literalOf(body.slice(open + 1, close));
    if (asserted?.includes(wanted)) return true;
  }
  return false;
}

export function orderingSites(file: string, src: string): readonly OrderSite[] {
  const found: OrderSite[] = [];
  for (const m of src.matchAll(/\bexpect\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = balanced(src, open);
    if (close < 0) continue;
    const tail = src.slice(close + 1, close + 40);
    const after = /^\s*\.\s*(toBeLessThan|toBeGreaterThan)\s*\(/.exec(tail);
    if (after === null) continue;
    const matcher = after[1] as OrderSite['matcher'];
    const argOpen = close + 1 + tail.indexOf('(', after[0].length - 1);
    const argClose = balanced(src, argOpen);
    // The asymmetry: only ONE side of each comparison can be passed by a phantom -1.
    const risky =
      matcher === 'toBeLessThan'
        ? src.slice(open + 1, close)
        : argClose > 0
          ? src.slice(argOpen + 1, argClose)
          : '';
    if (!FROM_INDEX.test(risky)) continue;
    const body = enclosingTest(src, open);
    // `.trim()` is not enough: a matcher argument on its own line ends with a TRAILING COMMA, so
    // the needle regex anchored at `$` matched nothing and the site read as unguarded even with an
    // exact `toContain` beside it. A false positive, which this file's own header says is how a
    // rule gets switched off. Measured on `packages/db/src/migrate.test.ts`.
    const operand = risky.trim().replace(/,\s*$/, '');
    const needle = /\b(?:indexOf|findIndex)\s*\(([\s\S]*)\)\s*$/.exec(operand)?.[1]?.trim();
    const contained = needle !== undefined && needle !== '' && containsNeedle(body, needle);
    found.push({
      file,
      line: src.slice(0, open).split('\n').length,
      matcher,
      risky: risky.replace(/\s+/g, ' ').trim(),
      guarded: contained || guardsExpression(body, risky),
    });
  }
  return found;
}

export interface TreeScan {
  readonly sites: readonly OrderSite[];
  readonly files: number;
}

/**
 * The one scan of the tree. Exported because `index-of-order.test.ts` asserts the real tree too,
 * and a test with its own copy of this loop diverges from the runner — which it did: the test kept
 * scanning the file the runner had learned to skip, so the rule was green and its own suite red.
 */
export async function scanTree(root: string): Promise<TreeScan> {
  const sites: OrderSite[] = [];
  let files = 0;
  for (const pattern of TEST_GLOBS) {
    for await (const relative of new Bun.Glob(pattern).scan({ cwd: root })) {
      const path = relative.split('\\').join('/');
      files += 1;
      // This rule's own test SPELLS the assertions it refuses, as fixtures inside template
      // literals — a scanner cannot tell those from real ones, and reporting them would make the
      // rule un-satisfiable. `sql-literal-copies` draws the same line for the escape it names.
      if (path === 'scripts/index-of-order.test.ts') continue;
      sites.push(...orderingSites(path, await Bun.file(`${root}/${path}`).text()));
    }
  }
  return { sites, files };
}

export function packageOfTest(path: string): string {
  return /^packages\/([^/]+)\//.exec(path)?.[1] ?? path.split('/')[0] ?? 'root';
}

export interface OrderInput {
  readonly sites: readonly OrderSite[];
  readonly pins: readonly OrderPin[];
  /** False means the scan read nothing, which must never read as a clean tree. */
  readonly scanned: boolean;
}

export function checkOrdering(input: OrderInput): readonly Finding[] {
  if (!input.scanned) {
    return [
      {
        code: 'X_INDEX_ORDER_UNSCANNED',
        cause: 'no test file was scanned, so no ordering assertion was checked',
        fix: 'run `bun run index-of-order` from the repo root; a Bun.Glob pattern it cannot expand matches zero files',
        at: 'scripts/index-of-order.ts',
      },
    ];
  }
  const pinned = new Map(input.pins.map((pin) => [pin.pkg, pin]));
  const counts = new Map<string, number>();
  for (const site of input.sites) {
    if (site.guarded) continue;
    const pkg = packageOfTest(site.file);
    counts.set(pkg, (counts.get(pkg) ?? 0) + 1);
  }
  const findings: Finding[] = [];
  for (const [pkg, count] of [...counts].sort()) {
    const pin = pinned.get(pkg);
    const allowed = pin?.count ?? 0;
    if (count <= allowed) continue;
    const worst = input.sites.find((site) => !site.guarded && packageOfTest(site.file) === pkg);
    const at = worst === undefined ? pkg : `${worst.file}:${String(worst.line)}`;
    findings.push({
      code: 'X_INDEX_ORDER_UNGUARDED',
      cause: `${pkg} has ${String(count)} ordering assertion(s) whose indexOf operand is never asserted present, above its pin of ${String(allowed)} — indexOf answers -1 for a needle it never found, and -1 passes ${worst?.matcher === 'toBeGreaterThan' ? 'as the greater-than ARGUMENT' : 'as the less-than RECEIVER'}, so the assertion holds when the thing it orders is not emitted at all`,
      fix: `assert presence first at ${at} — \`expect(<haystack>).toContain(<needle>)\`, or \`expect(<the index>).toBeGreaterThanOrEqual(0)\` — then compare. Prove it: delete what the assertion orders and watch the test go red`,
      at,
    });
  }
  for (const pin of input.pins) {
    // "There was a reason" is the documentation axiom 3 says does not exist. The pins file
    // declared this rule in prose and nothing read `reason`, so the first pin added in a hurry
    // would have carried none — `boundaries.ts` refuses a blank `FLOOR_ABOVE` reason the same way.
    if (pin.reason.trim() === '') {
      findings.push({
        code: 'X_INDEX_ORDER_PIN_UNEXPLAINED',
        cause: `${pin.pkg} is pinned with a blank reason, so nothing records what its remaining sites are or why they stand`,
        fix: `write what the remaining site(s) in ${pin.pkg} are and why they have not been repaired, in scripts/lib/index-of-order-pins.ts — or repair them and run bun run scripts/index-of-order.ts --unpin ${pin.pkg}`,
        at: 'scripts/lib/index-of-order-pins.ts',
      });
    }
    const count = counts.get(pin.pkg) ?? 0;
    if (count < pin.count) {
      findings.push({
        code: 'X_INDEX_ORDER_PIN_STALE',
        cause: `${pin.pkg} is pinned at ${String(pin.count)} unguarded ordering assertion(s) and now has ${String(count)}`,
        fix: `bun run scripts/index-of-order.ts --unpin ${pin.pkg}`,
        at: 'scripts/lib/index-of-order-pins.ts',
      });
    }
  }
  return findings;
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const { sites, files } = await scanTree(root);
  // `--unpin <pkg>[,<pkg>]` — the edit `X_INDEX_ORDER_PIN_STALE` names, performed. Advertised in
  // this file's header from the first draft and unimplemented until a review pointed at it: an
  // executable fix that is not executable is axiom 4 inverted.
  const unpin = args.flags.get('unpin');
  if (typeof unpin === 'string') {
    const names = new Set(
      unpin
        .split(',')
        .map((one) => one.trim())
        .filter((one) => one !== ''),
    );
    const kept = INDEX_OF_ORDER_PINS.filter((pin) => !names.has(pin.pkg));
    const unknown = [...names].filter(
      (name) => !INDEX_OF_ORDER_PINS.some((pin) => pin.pkg === name),
    );
    report(
      {
        ok: unknown.length === 0,
        script: SCRIPT,
        summary:
          unknown.length === 0
            ? `unpinned ${String(INDEX_OF_ORDER_PINS.length - kept.length)} package(s); write the remaining ${String(kept.length)} into scripts/lib/index-of-order-pins.ts`
            : `${String(unknown.length)} name(s) are not pinned`,
        findings: unknown.map((name) => ({
          code: 'X_INDEX_ORDER_PIN_STALE',
          cause: `${name} has no entry in INDEX_OF_ORDER_PINS, so there is nothing to unpin`,
          fix: 'bun run index-of-order --json  # the pinned names are in data.pins',
          at: 'scripts/lib/index-of-order-pins.ts',
        })),
        data: { pins: kept },
      },
      args.json,
    );
  } else {
    const findings = checkOrdering({ sites, pins: INDEX_OF_ORDER_PINS, scanned: files > 0 });
    const unguarded = sites.filter((site) => !site.guarded);
    report(
      {
        ok: findings.length === 0,
        script: SCRIPT,
        summary:
          findings.length === 0
            ? `${String(sites.length)} indexOf ordering assertion(s) across ${String(files)} test file(s), ${String(unguarded.length)} unguarded and every one pinned`
            : findings[0]?.code === 'X_INDEX_ORDER_UNSCANNED'
              ? 'this rule read nothing, so no ordering assertion was checked'
              : `${String(findings.length)} package(s) off the index-of-order ratchet`,
        findings,
        data: {
          files,
          sites: sites.length,
          unguarded: args.flags.get('explain') === true ? unguarded : unguarded.length,
        },
      },
      args.json,
    );
  }
}
