#!/usr/bin/env bun
// Enforce, as a gate step, that a test does not wait for the wall clock. A `Bun.sleep(30)` or a
// `setTimeout(resolve, 50)` in a test is time every run of the suite pays and a race a loaded CI
// runner decides — the package's own CLAUDE.md says "No wall clock" (`@ultimat3/testing`), and in
// test files that was prose: 355 sites across 173 files measured 2026-10-30, ~44 s of literal
// delays alone, under a green gate.
//
// Time passes in a test because the test MOVES it: the frozen clock (`advanceClock`, the `clock`
// fixture), Bun's fake timers (`jest.useFakeTimers()` + `jest.advanceTimersByTime(ms)`, the
// timers a subject arms with `setTimeout`/`setInterval`), the scrape clock (`noWaitClock`) — or
// it awaits the event itself. An event-loop turn is not a wait: `setTimeout(…, 0)`/`(…, 1)`,
// `Bun.sleep(0)` and `setImmediate` pass. What truly runs on another process's time (a browser, a
// server, a child) says so on the line or the line above: `// real-clock: <why>`. A ratchet per
// package (`scripts/lib/test-real-sleep-pins.ts`): the count may fall and never rise.
//
//   bun run scripts/test-real-sleep.ts [--json]
//   bun run scripts/test-real-sleep.ts --unpin <pkg>[,<pkg>]   # shrink the ratchet

import { renderFixShellArg } from '../packages/core/src/error-render';
import { stripComments } from '../packages/core/src/source-mask';
import type { Finding } from './lib/log';
import type { PinTable, RatchetGap } from './lib/ratchet';
import { ratchetGaps, ratchetMain } from './lib/ratchet';
import type { SiteProbe } from './lib/ratchet-sites';
import { leadSite, newSitesFirst, siteList, siteTarget } from './lib/ratchet-sites';
import { insideString, sourceStrings } from './lib/source-strings';
import { PINS_FILE, REAL_SLEEP_PINS } from './lib/test-real-sleep-pins';
import { readTestSources } from './test-fix-citations';

const SCRIPT = 'test-real-sleep';
const EXPLAIN = 'bun run scripts/test-real-sleep.ts --explain --json lists every one';

/** A wall-clock wait: `Bun.sleep(`, `Bun.sleepSync(`, and a GLOBAL `setTimeout(` / `setInterval(`. */
const CALL =
  /(?<![\w$.])(Bun\.sleepSync|Bun\.sleep|(?:globalThis\.|window\.)?set(?:Timeout|Interval))\s*\(/g;
/** A delay that only yields one event-loop turn. */
const TURN = /^\s*[01]\s*$/;
/** The escape, as a line comment on the line or the one above; a reason is required. */
export const REAL_CLOCK = /\/\/\s*real-clock:\s*\S.{2,}/;

export interface RealSleepSite {
  readonly path: string;
  readonly line: number;
  /** The call as written, its delay argument kept: `setTimeout(…, 50)`. */
  readonly call: string;
}

/**
 * The top-level arguments of the call whose `(` is at `open`; `undefined` when it never closes. A
 * delimiter inside a string (`inString`) is text, never structure: `log(")")` keeps its delay.
 */
export function callArguments(
  code: string,
  open: number,
  inString: (at: number) => boolean = () => false,
): readonly string[] | undefined {
  const parts: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let at = open; at < code.length; at += 1) {
    const ch = code[at];
    if (at > open && inString(at)) continue;
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth > 0) continue;
      const last = code.slice(start, at);
      return last.trim() === '' && parts.length > 0 ? parts : [...parts, last];
    } else if (ch === ',' && depth === 1) {
      parts.push(code.slice(start, at));
      start = at + 1;
    }
  }
  return undefined;
}

/** The call as a reader names it, or `undefined` when it only yields a turn. */
function waitOf(callee: string, args: readonly string[] | undefined): string | undefined {
  const name = callee.replace(/^(?:globalThis|window)\./, '');
  const squash = (text: string | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim();
  if (name === 'Bun.sleepSync') return `Bun.sleepSync(${squash(args?.[0])})`;
  if (name === 'Bun.sleep') {
    return squash(args?.[0]) === '0' ? undefined : `Bun.sleep(${squash(args?.[0])})`;
  }
  const delay = args?.[1];
  if (name === 'setTimeout' && (delay === undefined || TURN.test(delay))) return undefined;
  return `${name}(…, ${squash(delay) || '?'})`;
}

export function scanRealSleeps(path: string, source: string): readonly RealSleepSite[] {
  // Comments are prose, and a rule's own test spells the bad shape as a STRING: neither is a call.
  const code = stripComments(source);
  const literals = sourceStrings(source);
  const lines = source.split('\n');
  const out: RealSleepSite[] = [];
  for (const match of code.matchAll(CALL)) {
    const at = match.index ?? 0;
    if (insideString(literals, at)) continue;
    const call = waitOf(
      match[1] ?? '',
      callArguments(code, at + match[0].length - 1, (pos) => insideString(literals, pos)),
    );
    if (call === undefined) continue;
    const line = source.slice(0, at).split('\n').length;
    if (REAL_CLOCK.test(lines[line - 1] ?? '') || REAL_CLOCK.test(lines[line - 2] ?? '')) continue;
    out.push({ path, line, call });
  }
  return out;
}

export type RealSleepGap = RatchetGap<RealSleepSite>;

export interface RealSleepInput {
  readonly files: readonly { readonly path: string; readonly text: string }[];
  readonly pins: PinTable;
}

export const checkRealSleeps = (input: RealSleepInput): readonly RealSleepGap[] =>
  ratchetGaps(
    input.files.flatMap((file) => scanRealSleeps(file.path, file.text)),
    input.pins,
    input.files.length > 0,
  );

const at = (site: RealSleepSite | undefined): string =>
  site === undefined ? '' : `${site.path}:${String(site.line)} ${site.call}`;

const overFinding = (gap: RealSleepGap): Finding => ({
  code: 'X_TEST_REAL_SLEEP',
  cause: `${gap.pkg} has ${String(gap.found)} test wait(s) on the wall clock and is pinned at ${String(gap.pinned)} — ${siteList(gap, at, EXPLAIN)} — every run of the suite pays them, and a loaded runner turns "long enough" into a race`,
  fix: `jest.useFakeTimers(); jest.advanceTimersByTime(ms)   # at ${siteTarget(gap, at)}: move the timers the subject arms instead of waiting for them (bun:test) — advanceClock / the clock fixture for Date.now(), or await the event itself; an event-loop turn is setTimeout(…, 0) or setImmediate. Another process's time only, with "// real-clock: <why>" on the line or the line above`,
  at: leadSite(gap)?.path ?? PINS_FILE,
});

const staleFinding = (gap: RealSleepGap): Finding => ({
  code: 'X_TEST_REAL_SLEEP_PIN_STALE',
  cause: `${gap.pkg} is pinned at ${String(gap.pinned)} wall-clock test wait(s) and has ${String(gap.found)} — the pin is above what this tree contains, so it would let ${String(gap.pinned - gap.found)} back in`,
  fix: `bun run scripts/test-real-sleep.ts --unpin ${renderFixShellArg(gap.pkg, '<pkg>')}`,
  at: PINS_FILE,
});

const unscannedFinding = (): Finding => ({
  code: 'X_TEST_REAL_SLEEP_UNSCANNED',
  cause:
    'no test file was read, so every package reports zero and the ratchet enforces nothing — a glob that matches nothing reads exactly like a clean tree',
  fix: "bun run scripts/test-real-sleep.ts --explain --json   # reads nothing: TEST_GLOBS in scripts/test-fix-citations.ts must match this repo's test layout",
  at: 'scripts/test-real-sleep.ts',
});

export const realSleepFindingFor = (gap: RealSleepGap): Finding =>
  gap.kind === 'over'
    ? overFinding(gap)
    : gap.kind === 'stale'
      ? staleFinding(gap)
      : unscannedFinding();

const treeSites = async (root: string): Promise<readonly RealSleepSite[]> =>
  (await readTestSources(root)).flatMap((file) => scanRealSleeps(file.path, file.text));

const PROBE: SiteProbe<RealSleepSite> = { rescan: scanRealSleeps, line: (site) => site.line };

export const realSleepGaps = async (root: string): Promise<readonly RealSleepGap[]> =>
  newSitesFirst(root, ratchetGaps(await treeSites(root), REAL_SLEEP_PINS, true), PROBE);

/** What this repo contributes to `x verify`'s `errors` step. */
export const realSleepFindings = async (root: string): Promise<readonly Finding[]> =>
  (await realSleepGaps(root)).map(realSleepFindingFor);

if (import.meta.main) {
  await ratchetMain({
    script: SCRIPT,
    pinsFile: PINS_FILE,
    pins: REAL_SLEEP_PINS,
    sites: treeSites,
    findingFor: realSleepFindingFor,
    probe: PROBE,
    clean: 'no package waits for the wall clock in a test above its pin',
  });
}
