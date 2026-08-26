#!/usr/bin/env bun
// Enforce, as a ratchet, that a NUMERIC option defaulted with `??` is checked for finiteness. `??`
// guards nullish and `NaN` is not nullish, so the default never fires and the number arrives at
// whatever it bounds intact.
//
// THE DEFECT THIS EXISTS FOR, four outcomes, all measured in this tree in one day:
//
//   a COMPARISON reads false forever    `NaN < 1` — `AcceptBudget.tryAccept()` admitted every
//                                       accept, herd included; `bytes > NaN` — `SyncSocket.send()`
//                                       answered TRUE with 10 MB queued, so a frame the runtime
//                                       discarded was reported delivered and never reached
//                                       `channel_frames_dropped_total`; `visibleAt <= now` — a job
//                                       whose worker DIED was never claimable again.
//   an ARRAY LENGTH or SLICE collapses  `Array.from({ length: NaN })` is `[]`, so `@ultimat3/ai`'s
//                                       `hive({ concurrency: NaN })` ran zero workers and reported
//                                       clean success; `slice(0, NaN)` is `[]`, so a worker claimed
//                                       nothing and reported healthy.
//   a TIMER reads as ZERO               `setTimeout(fn, NaN)` and `setInterval(fn, NaN)` coerce to
//                                       0: a poll becomes a spin, one round trip per event-loop
//                                       turn per replica.
//   a LOOP BOUND never terminates       `@ultimat3/ai`'s `chunk({ size: NaN })` — a SYNCHRONOUS
//                                       infinite loop, past every `AbortSignal`, past the job
//                                       timeout, past the watchdog, on the worker's only thread.
//
// Which failure you get is decided by what the number lands on. The MISSING CHECK is the same one,
// so that is what this rule reads — never the landing site, which no text rule can follow.
//
// `Math.max(1, x)` / `Math.min(x, y)` / `Math.floor(x)` ARE NOT VALIDATORS and are not accepted as
// one. All three PROPAGATE `NaN`, and this repo has now relied on all three as guards:
// `AcceptBudget` was `Math.max(1, options.perSecond)`, `presence.ts` was
// `Math.max(1, options.maxMembers ?? …)`, `worker.ts` was `Math.max(0, slots - inFlight)`. A `??`
// default is not a validator either, for the reason in the first line.
//
// WHAT COUNTS AS THE REPAIR, recognised rather than pinned: `Number.isFinite` /
// `Number.isSafeInteger` / `Number.isInteger` naming the option or the name it lands in, or a call
// whose own name carries `Finite` (`assertFiniteCeiling`, `assertFiniteRate`, `finite`) naming the
// same. In-repo form, eight times over: `packages/jobs/src/limits.ts:122`, `backfill.ts:158`,
// `export.ts:142`, `job.ts:201`, `worker-options.ts`, `scraping/src/scrape.ts:137`,
// `mail/src/driver-smtp.ts:97`.
//
// MATCHED ON SHAPE, NEVER ON NAME. A rule spelled `RenderMode` read straight past `PwaRenderMode`,
// and a backoff rule looking for a roll called `random`/`rng`/`roll` read past a copy whose
// parameter was `r`. Nothing here asks whether an option is called `timeout`, `limit` or `size`.
//
// WHAT IT THEREFORE CANNOT SEE, stated so nobody trusts it for more than it does:
//   1. an option with NO `??` default — `AcceptBudget`'s required `perSecond` was exactly this, and
//      only its `burst` sibling was visible. A required numeric option is invisible to this rule.
//   2. a number that arrives as a function PARAMETER rather than a property of an options object.
//   3. a repair in a DIFFERENT file. `socket.ts` passing `maxFramesPerSecond` into `AcceptBudget`'s
//      own assert reads as unchecked here, and the answer is to refuse it where it is written too —
//      which is the layered form `backfill()` and `inBatches()` already use.
//   4. a default that is not a numeric LITERAL and not a `SCREAMING_SNAKE` constant this corpus
//      declares as one. `?? 0` and `?? 1` are excluded outright: they are accumulator identities
//      (`map.get(k) ?? 0`), not configuration, and they were the whole of the noise floor.
//
//   bun run finite-bounds  ·  bun run scripts/finite-bounds.ts [--json] [--explain]
//   bun run scripts/finite-bounds.ts --unpin <pkg>[,<pkg>]   # shrink the ratchet

import { maskLiterals } from '@ultimat3/cli';
import { collectSourceFiles, type SourceFile } from './boundaries';
import { flagList, parseScriptArgs } from './lib/args';
import {
  applyFiniteBoundsUnpin,
  FINITE_BOUNDS_PINS,
  FINITE_BOUNDS_PINS_FILE,
  finiteBoundsPinnedFor,
} from './lib/finite-bounds-pins';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { isTestPath, lineOf } from './lib/source-scan';
import { packageOf } from './test-fix-citations';

const SCRIPT = 'finite-bounds';

/** Source the CLI EMITS rather than executes, and generated fixtures. Neither is shipped logic. */
const TEMPLATE_ROOT = 'packages/cli/src/templates/';
const isFixture = (path: string): boolean => /-fixture\.tsx?$/.test(path);

/**
 * `const DEFAULT_X = 1024;` — a `SCREAMING_SNAKE` constant this corpus declares as a NUMBER.
 *
 * Why the corpus and not the line: a default is routinely imported (`DEFAULT_VISIBILITY_TIMEOUT_MS`
 * lives in `driver.ts` and is read in `worker-options.ts`). Why numeric at all: the same spelling
 * carries strings and objects — `?? DEFAULT_QUEUE`, `?? NO_TENANT`, `?? DEFAULT_RETRY`,
 * `?? CLOUDFLARE_API_URL`, `?? NEVER_ABORTED` — and reporting those is the noise that gets a rule
 * switched off. A name declared numeric in one place and non-numeric in another is NOT numeric.
 */
const CONST_DECL = /(?:const|let)\s+([A-Z][A-Z0-9_]{2,})\s*(?::[^=]*)?=\s*([^;\n]+)/g;
const NUMERIC_LITERAL = /^-?\d[\d_]*(?:\.\d[\d_]*)?(?:e[+-]?\d+)?$/i;
/**
 * Arithmetic over numeric literals and nothing else — `1024 * 1024`, `60 * 60 * 1000`. No letters,
 * so an identifier can never satisfy it. Without this, `DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024`
 * read as non-numeric and the four `change-buffer.ts` byte ceilings were invisible.
 */
const NUMERIC_EXPRESSION = /^[\d_.\s*+\-/()]+$/;
const isNumericValue = (value: string): boolean =>
  NUMERIC_LITERAL.test(value) || (/\d/.test(value) && NUMERIC_EXPRESSION.test(value));

export function numericConstants(files: readonly SourceFile[]): ReadonlySet<string> {
  const numeric = new Set<string>();
  const other = new Set<string>();
  for (const file of files) {
    for (const match of CONST_DECL.exec.length > 0 ? file.source.matchAll(CONST_DECL) : []) {
      const name = match[1] as string;
      const value = (match[2] as string).trim();
      if (isNumericValue(value)) numeric.add(name);
      else other.add(name);
    }
  }
  for (const name of other) numeric.delete(name);
  return numeric;
}

/**
 * `options.maxBytes ?? 1024` — a dotted property read, nullish-coalesced to a number.
 *
 * The left side is a PURE dotted path: no call, no index, no optional chain. That is what keeps
 * `map.get(k) ?? 0`, `buffer[0] ?? 0`, `rows[0]?.pending ?? 0` and `queue?.pending().length ?? 0`
 * out — every one of which is an accumulator or an element read, not configuration.
 */
const DEFAULTED =
  /(?<![\w$.?])([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\s*\?\?\s*([\w$.]+)(?![\w$(.])/g;

/** Repairs, in one alternation: `Number.is*` or any callee carrying `Finite`. */
const REPAIR_CALL = /(?:Number\.is(?:Finite|SafeInteger|Integer)|\b[\w$]*[Ff]inite[\w$]*)\s*\(/g;

/** The `)` closing the `(` at `open`, or the end of the file. */
const closingParen = (code: string, open: number): number => {
  let depth = 0;
  for (let index = open; index < code.length; index += 1) {
    const char = code[index] as string;
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return code.length;
};

export interface FiniteBoundSite {
  readonly path: string;
  readonly line: number;
  /** The option's own property name — `maxBytes` in `options.maxBytes ?? 1024`. */
  readonly option: string;
  /** The whole `a.b ?? DEFAULT` expression, so a finding can quote it back. */
  readonly expression: string;
}

/** `this.#maxBytes =` / `const size =` / `let n =` on the text before the match, or nothing. */
const ASSIGNED = /(?:(?:const|let|var)\s+|this\.#?|#)([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*$/;

/**
 * Every finiteness check in a file, as the text between its parentheses.
 *
 * The SPAN and not the line, because Biome wraps a call past 100 columns and the callee then sits
 * on a different line from its arguments — the first draft compared line by line and read nine of
 * its own repairs as unrepaired. Balanced parens, so a nested `toMs(...)` stays inside the span.
 */
const repairSpans = (source: string): readonly string[] => {
  const spans: string[] = [];
  for (const match of source.matchAll(REPAIR_CALL)) {
    const open = match.index + match[0].length - 1;
    spans.push(source.slice(open, closingParen(source, open) + 1));
  }
  return spans;
};

/**
 * Whether some check in this file NAMES one of these subjects.
 *
 * Whole file, because the assert is routinely a few lines from the read and sometimes above it —
 * but it must name the subject, so repairing one of `change-buffer.ts`'s four bounds does not
 * silence the other three. Naming is not the DETECTOR, which is shape only; it is how the rule
 * tells which repair belongs to which site.
 */
const repaired = (spans: readonly string[], subjects: readonly string[]): boolean =>
  spans.some((span) =>
    subjects.some((subject) =>
      new RegExp(`(?<![\\w$])${RegExp.escape(subject)}(?![\\w$])`).test(span),
    ),
  );

/**
 * Every unchecked numeric option in one file, in source order.
 *
 * Read from `maskLiterals`' output — a string's contents blanked, every offset preserved — so a
 * scaffold template emitting `options.x ?? 30_000` inside a template literal is not read as this
 * file's own option. The repair scan reads the ORIGINAL, because `finite('pollIntervalMs', …)`
 * names its subject inside a string literal the mask would blank.
 */
export function scanFiniteBounds(
  path: string,
  source: string,
  numeric: ReadonlySet<string>,
): readonly FiniteBoundSite[] {
  const code = maskLiterals(source);
  const spans = repairSpans(source);
  const sites: FiniteBoundSite[] = [];
  for (const match of code.matchAll(DEFAULTED)) {
    const fallback = (match[2] as string).trim();
    // Accumulator identities, not configuration — and the whole of the noise floor.
    if (fallback === '0' || fallback === '1') continue;
    if (!NUMERIC_LITERAL.test(fallback) && !numeric.has(fallback)) continue;
    const path0 = match[1] as string;
    const option = path0.slice(path0.lastIndexOf('.') + 1);
    const lineStart = code.lastIndexOf('\n', match.index) + 1;
    const assigned = ASSIGNED.exec(code.slice(lineStart, match.index));
    const subjects = assigned === null ? [option] : [option, assigned[1] as string];
    if (repaired(spans, subjects)) continue;
    sites.push({
      path,
      line: lineOf(code, match.index),
      option,
      expression: match[0].trim(),
    });
  }
  return sites;
}

const scannable = (file: SourceFile): boolean =>
  !isTestPath(file.path) && !isFixture(file.path) && !file.path.startsWith(TEMPLATE_ROOT);

export type FiniteBoundGapKind = 'over' | 'stale' | 'unscanned';

export interface FiniteBoundGap {
  readonly kind: FiniteBoundGapKind;
  readonly pkg: string;
  readonly found: number;
  readonly pinned: number;
  readonly first?: FiniteBoundSite;
}

export interface FiniteBoundsInput {
  readonly files: readonly SourceFile[];
  readonly pins: Readonly<Record<string, FiniteBoundPinShape>>;
}

interface FiniteBoundPinShape {
  readonly count: number;
  readonly reason: string;
}

/** Every site per package, in source order — the one scan `--explain`, the ratchet and `--unpin` share. */
export function finiteBoundSites(
  files: readonly SourceFile[],
): ReadonlyMap<string, readonly FiniteBoundSite[]> {
  const numeric = numericConstants(files);
  const found = new Map<string, FiniteBoundSite[]>();
  for (const file of files) {
    if (!scannable(file)) continue;
    for (const site of scanFiniteBounds(file.path, file.source, numeric)) {
      const list = found.get(packageOf(site.path)) ?? [];
      list.push(site);
      found.set(packageOf(site.path), list);
    }
  }
  return found;
}

/** The ratchet: a package may hold what it is pinned at, may fall, may never rise. */
export function checkFiniteBounds(input: FiniteBoundsInput): readonly FiniteBoundGap[] {
  if (input.files.length === 0) {
    return [{ kind: 'unscanned', pkg: '', found: 0, pinned: 0 }];
  }
  const found = finiteBoundSites(input.files);
  const gaps: FiniteBoundGap[] = [];
  for (const pkg of new Set([...found.keys(), ...Object.keys(input.pins)])) {
    const hits = found.get(pkg) ?? [];
    const pinned = finiteBoundsPinnedFor(pkg, input.pins);
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

const at = (site: FiniteBoundSite | undefined): string =>
  site === undefined ? '' : `${site.path}:${String(site.line)}`;

const overFinding = (gap: FiniteBoundGap): Finding => ({
  code: 'X_FINITE_BOUND_UNCHECKED',
  cause: `${gap.pkg} defaults ${String(gap.found)} numeric option(s) with ?? and never checks them for finiteness, and is pinned at ${String(gap.pinned)} — ${at(gap.first)} writes ${gap.first?.expression ?? ''}, and ?? guards nullish while NaN is not nullish, so Number(process.env.X) on an unset variable reaches the bound intact`,
  fix: `assert(Number.isFinite(${gap.first?.option ?? 'value'}), '…', '…') beside ${at(gap.first)} — as packages/jobs/src/limits.ts:122 does — or Number.isSafeInteger where it counts rows. Math.max/Math.min/Math.floor are NOT the fix: all three propagate NaN`,
  at: at(gap.first),
});

const staleFinding = (gap: FiniteBoundGap): Finding => ({
  code: 'X_FINITE_BOUND_PIN_STALE',
  cause: `${gap.pkg} is pinned at ${String(gap.pinned)} unchecked numeric option(s) and has ${String(gap.found)} — the pin is above what this tree contains, so it would let ${String(gap.pinned - gap.found)} back in`,
  fix: `bun run scripts/finite-bounds.ts --unpin ${gap.pkg}`,
  at: FINITE_BOUNDS_PINS_FILE,
});

const unscannedFinding = (): Finding => ({
  code: 'X_FINITE_BOUND_UNSCANNED',
  cause:
    'no source file was read, so every package reports zero and the ratchet enforces nothing — a glob that matches nothing reads exactly like a tree where every bound is checked',
  fix: 'edit SOURCE_PATTERNS in scripts/boundaries.ts so it matches this repo layout, then bun run scripts/finite-bounds.ts',
  at: 'scripts/boundaries.ts',
});

/**
 * A `Map` and not the `Record` object literal every sibling ratchet uses, because that shape is
 * `bun run proto-index`'s own finding — `FINDINGS[gap.kind]` answers an `Object.prototype` member
 * for the kind `constructor`. A new rule must not arrive owing a debt to an older one.
 */
const FINDINGS = new Map<FiniteBoundGapKind, (gap: FiniteBoundGap) => Finding>([
  ['over', overFinding],
  ['stale', staleFinding],
  ['unscanned', unscannedFinding],
]);

export const finiteBoundFindingFor = (gap: FiniteBoundGap): Finding =>
  (FINDINGS.get(gap.kind) ?? unscannedFinding)(gap);

export const finiteBoundGaps = async (root: string): Promise<readonly FiniteBoundGap[]> =>
  checkFiniteBounds({ files: await collectSourceFiles(root), pins: FINITE_BOUNDS_PINS });

/** What this rule contributes to `x verify`'s `unit` step, through `finite-bounds.test.ts`. */
export const finiteBoundFindings = async (root: string): Promise<readonly Finding[]> =>
  (await finiteBoundGaps(root)).map(finiteBoundFindingFor);

export async function finiteBoundCounts(root: string): Promise<Readonly<Record<string, number>>> {
  const counts: Record<string, number> = {};
  for (const [pkg, sites] of finiteBoundSites(await collectSourceFiles(root))) {
    counts[pkg] = sites.length;
  }
  return counts;
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const unpin = flagList(args, 'unpin');
  if (unpin.length > 0) {
    const lowered = await applyFiniteBoundsUnpin(root, unpin, await finiteBoundCounts(root));
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
    const files = await collectSourceFiles(root);
    const sites = finiteBoundSites(files);
    const gaps = checkFiniteBounds({ files, pins: FINITE_BOUNDS_PINS });
    const total = [...sites.values()].reduce((sum, list) => sum + list.length, 0);
    report(
      {
        ok: gaps.length === 0,
        script: SCRIPT,
        summary:
          gaps.length === 0
            ? `${String(total)} numeric option(s) defaulted with ?? across packages/*/src, none above its pin`
            : `${String(gaps.length)} package(s) off the finite-bounds ratchet`,
        findings: gaps.map(finiteBoundFindingFor),
        data:
          args.flags.get('explain') === true
            ? { sites: Object.fromEntries(sites) }
            : { counts: await finiteBoundCounts(root) },
      },
      args.json,
    );
  }
}
