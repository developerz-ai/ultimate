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
//   bun run index-of-order  ·  bun run scripts/index-of-order.ts [--json] [--explain]
//   bun run scripts/index-of-order.ts --unpin <pkg>[,<pkg>]   # shrink the ratchet

import { parseScriptArgs } from './lib/args';
import { INDEX_OF_ORDER_PINS, type OrderPin } from './lib/index-of-order-pins';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

const SCRIPT = 'index-of-order';

/**
 * Every tree a test can live in. Listed one per entry and never brace-expanded: `Bun.Glob` does
 * NOT support `{a,b}`, and a pattern it cannot expand matches ZERO files — which this rule would
 * have reported as a clean tree. Measured while writing it.
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
  /\.toBeGreaterThanOrEqual\s*\(\s*0\s*\)/,
  /\.toBeGreaterThan\s*\(\s*-1\s*\)/,
  /\.not\s*\.\s*toBe\s*\(\s*-1\s*\)/,
  /\.toBe\s*\(\s*\d+\s*\)/,
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
    } else if (c === "'" || c === '"' || c === '`') {
      i += 1;
      while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
    }
  }
  return -1;
}

/** The body of the `test(`/`it(` containing `at`, or the whole file when it sits outside one. */
function enclosingTest(src: string, at: number): string {
  const before = src.slice(0, at);
  const start = Math.max(before.lastIndexOf('\n  test('), before.lastIndexOf('\n  it('));
  if (start < 0) return src;
  const open = src.indexOf('(', start + 1);
  const close = balanced(src, open);
  return close > at ? src.slice(open, close) : src;
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
      guarded: contained || GUARDS.some((guard) => guard.test(body)),
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
