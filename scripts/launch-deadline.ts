#!/usr/bin/env bun
// Enforce, as a gate step, that a test awaiting a browser launch is given the launch's own designed
// budget, never a number of its own. A test deadline below the launch's is Bun killing the test
// while a cold Chrome is still starting — on a loaded Windows runner, with the launch's
// `X_CDP_LAUNCH_FAILED` (which names the slow step) never surfacing (`be5b7edb8`, `dcc21ed6f`). A
// `test(…)` / `it(…)` whose body calls `launchChrome(`, `launchReady(`, `launchAttempt(`,
// `launchFoundChrome(` or `openE2eBrowser…(` takes `LAUNCH_TEST_MS`, `launchTestMs(<launch ms>)`
// (`@ultimat3/scraping/cdp`) or `E2E_BROWSER_OPEN_MS` (`@ultimat3/testing`) as its timeout — never
// a literal, and never Bun's 5 s default. A hook that opens a browser is `e2e-browser-hooks.test.ts`'s.
//
//   bun run scripts/launch-deadline.ts [--json]
//   bun run scripts/launch-deadline.ts --unpin <pkg>[,<pkg>]   # shrink the ratchet

import { renderFixShellArg } from '../packages/core/src/error-render';
import { stripComments } from '../packages/core/src/source-mask';
import { LAUNCH_DEADLINE_PINS, PINS_FILE } from './lib/launch-deadline-pins';
import type { Finding } from './lib/log';
import type { PinTable, RatchetGap } from './lib/ratchet';
import { ratchetGaps, ratchetMain } from './lib/ratchet';
import type { SiteProbe } from './lib/ratchet-sites';
import { leadSite, newSitesFirst, siteList, siteTarget } from './lib/ratchet-sites';
import { insideString, sourceStrings } from './lib/source-strings';
import { readTestSources } from './test-fix-citations';
import { callArguments } from './test-real-sleep';

const SCRIPT = 'launch-deadline';
const EXPLAIN = 'bun run scripts/launch-deadline.ts --explain --json lists every one';

/** A call that starts a browser process. */
const LAUNCH =
  /(?<![\w$.])(?:launchChrome|launchReady|launchAttempt|launchFoundChrome|openE2eBrowser(?:IfAvailable)?)\s*\(/g;
/** A test call's last opening paren: `test(`, `test.skipIf(x)(`, `test.each(rows)(`. */
const TEST_CALL = /(?<![\w$.])(?:test|it)(?:\.\w+)*(?:\([^()]*\))?\s*\(/g;
/** A deadline derived from the launch's designed budget. */
const DERIVED = /^\s*(?:LAUNCH_TEST_MS|E2E_BROWSER_OPEN_MS)\b|^\s*launchTestMs\s*\(/;
/** Where a deadline argument can only be reading: a launch's options are not a test's timeout. */
const MAY_LAUNCH = /launch|openE2eBrowser/;

export interface LaunchDeadlineSite {
  readonly path: string;
  /** The line of the test call whose deadline it is. */
  readonly line: number;
  /** The deadline as written, or Bun's default. */
  readonly deadline: string;
}

interface TestSpan {
  readonly start: number;
  readonly end: number;
  readonly deadline: string | undefined;
}

/** Every test call in `code`, with its span and its third argument. */
function testSpans(code: string, inString: (at: number) => boolean): readonly TestSpan[] {
  const spans: TestSpan[] = [];
  for (const match of code.matchAll(TEST_CALL)) {
    const start = match.index ?? 0;
    if (inString(start)) continue;
    const open = start + match[0].length - 1;
    const args = callArguments(code, open, inString);
    if (args === undefined) continue;
    const consumed = args.reduce((sum, arg) => sum + arg.length + 1, 0);
    spans.push({ start, end: open + consumed, deadline: args[2]?.trim() });
  }
  return spans;
}

/** Every test that awaits a launch under a deadline it chose itself, once per test. */
export function scanLaunchDeadlines(path: string, source: string): readonly LaunchDeadlineSite[] {
  if (!path.includes('.test.') || !MAY_LAUNCH.test(source)) return [];
  const code = stripComments(source);
  const literals = sourceStrings(source);
  const inString = (at: number): boolean => insideString(literals, at);
  const spans = testSpans(code, inString);
  const flagged = new Set<TestSpan>();
  for (const match of code.matchAll(LAUNCH)) {
    const at = match.index ?? 0;
    if (inString(at)) continue;
    // The innermost test holding the call: a launch in a helper or a hook is not a test's deadline.
    const holder = spans
      .filter((span) => span.start < at && at < span.end)
      .sort((a, b) => b.start - a.start)[0];
    if (holder === undefined || DERIVED.test(holder.deadline ?? '')) continue;
    flagged.add(holder);
  }
  return [...flagged].map((span) => ({
    path,
    line: source.slice(0, span.start).split('\n').length,
    deadline: span.deadline ?? "Bun's 5000 ms default",
  }));
}

export type LaunchDeadlineGap = RatchetGap<LaunchDeadlineSite>;

export interface LaunchDeadlineInput {
  readonly files: readonly { readonly path: string; readonly text: string }[];
  readonly pins: PinTable;
}

export const checkLaunchDeadlines = (input: LaunchDeadlineInput): readonly LaunchDeadlineGap[] =>
  ratchetGaps(
    input.files.flatMap((file) => scanLaunchDeadlines(file.path, file.text)),
    input.pins,
    input.files.length > 0,
  );

const at = (site: LaunchDeadlineSite | undefined): string =>
  site === undefined ? '' : `${site.path}:${String(site.line)} (${site.deadline})`;

const overFinding = (gap: LaunchDeadlineGap): Finding => ({
  code: 'X_TEST_LAUNCH_DEADLINE',
  cause: `${gap.pkg} has ${String(gap.found)} test(s) awaiting a browser launch under a deadline of their own and is pinned at ${String(gap.pinned)} — ${siteList(gap, at, EXPLAIN)} — Bun kills such a test while a cold browser is still starting, and the launch's own refusal never surfaces`,
  fix: `test(name, fn, launchTestMs(launchTimeoutMs))   # at ${siteTarget(gap, at)}: LAUNCH_TEST_MS at the default launch deadline, from @ultimat3/scraping/cdp (launchReady() waits for the page target too); a test opening the e2e browser takes E2E_BROWSER_OPEN_MS from @ultimat3/testing`,
  at: leadSite(gap)?.path ?? PINS_FILE,
});

const staleFinding = (gap: LaunchDeadlineGap): Finding => ({
  code: 'X_TEST_LAUNCH_DEADLINE_PIN_STALE',
  cause: `${gap.pkg} is pinned at ${String(gap.pinned)} launch test(s) on a deadline of their own and has ${String(gap.found)} — the pin is above what this tree contains, so it would let ${String(gap.pinned - gap.found)} back in`,
  fix: `bun run scripts/launch-deadline.ts --unpin ${renderFixShellArg(gap.pkg, '<pkg>')}`,
  at: PINS_FILE,
});

const unscannedFinding = (): Finding => ({
  code: 'X_TEST_LAUNCH_DEADLINE_UNSCANNED',
  cause:
    'no test file was read, so every package reports zero and the ratchet enforces nothing — a glob that matches nothing reads exactly like a clean tree',
  fix: "bun run scripts/launch-deadline.ts --explain --json   # reads nothing: TEST_GLOBS in scripts/test-fix-citations.ts must match this repo's test layout",
  at: 'scripts/launch-deadline.ts',
});

export const launchDeadlineFindingFor = (gap: LaunchDeadlineGap): Finding =>
  gap.kind === 'over'
    ? overFinding(gap)
    : gap.kind === 'stale'
      ? staleFinding(gap)
      : unscannedFinding();

const treeSites = async (root: string): Promise<readonly LaunchDeadlineSite[]> =>
  (await readTestSources(root)).flatMap((file) => scanLaunchDeadlines(file.path, file.text));

const PROBE: SiteProbe<LaunchDeadlineSite> = {
  rescan: scanLaunchDeadlines,
  line: (site) => site.line,
};

export const launchDeadlineGaps = async (root: string): Promise<readonly LaunchDeadlineGap[]> =>
  newSitesFirst(root, ratchetGaps(await treeSites(root), LAUNCH_DEADLINE_PINS, true), PROBE);

/** What this repo contributes to `x verify`'s `errors` step. */
export const launchDeadlineFindings = async (root: string): Promise<readonly Finding[]> =>
  (await launchDeadlineGaps(root)).map(launchDeadlineFindingFor);

if (import.meta.main) {
  await ratchetMain({
    script: SCRIPT,
    pinsFile: PINS_FILE,
    pins: LAUNCH_DEADLINE_PINS,
    sites: treeSites,
    findingFor: launchDeadlineFindingFor,
    probe: PROBE,
    clean: 'every test awaiting a browser launch is given the launch budget',
  });
}
