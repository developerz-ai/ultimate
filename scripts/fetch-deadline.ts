#!/usr/bin/env bun
// Enforce, as a ratchet, that a shipped `fetch(` carries a `signal` in its own options. A fetch with
// no signal outlives the request, the job or the drain that made it, and a stalled vendor holds a
// socket for as long as it likes. `outbound()` (`@ultimat3/core/outbound`) is the repair; a pin with
// its sentence is the other answer. The rule an APP gets is the shipped `raw-fetch` guard.
//   bun run fetch-deadline [--json] [--explain]  ·  bun run scripts/fetch-deadline.ts --unpin <pkg>

import { renderFixShellArg } from '@ultimat3/core';
import { maskLiterals } from '../packages/core/src/source-mask';
import { balancedClose } from './lib/balanced-paren';
import { corpus } from './lib/corpus';
import { FETCH_DEADLINE_PINS, FETCH_DEADLINE_PINS_FILE } from './lib/fetch-deadline-pins';
import type { Finding } from './lib/log';
import type { PinTable, RatchetGap } from './lib/ratchet';
import { ratchetGaps, ratchetMain } from './lib/ratchet';
import type { SiteProbe } from './lib/ratchet-sites';
import { leadSite, newSitesFirst, siteList, siteTarget } from './lib/ratchet-sites';
import { isTestPath, lineOf } from './lib/source-scan';
import { hasTopLevelKey } from './lib/top-level-key';

const SCRIPT = 'fetch-deadline';
const EXPLAIN = 'bun run scripts/fetch-deadline.ts --explain --json lists every one';

/** A bare or `globalThis.` call. `deps.fetch(` is an injected seam, out of scope by design. */
const CALL = /(?<![\w$.])(?:globalThis\s*\.\s*)?fetch\s*\(/g;
const SIGNAL = /(?<![\w$.])signal\s*[:,}]/g;

const hasSignal = (args: string): boolean => hasTopLevelKey(args, SIGNAL);

export interface FetchSite {
  readonly path: string;
  readonly line: number;
  /** The call as written, up to its `(` — `fetch`, `globalThis.fetch`. */
  readonly call: string;
}

/**
 * Every unsignalled `fetch(` in one shipped file. A method DEFINITION (`fetch(request) {`, a
 * `Bun.serve` handler, a `fetch(url): Promise<…>` signature) is not a call. WHAT IT CANNOT SEE:
 * options passed as a variable read as unsignalled, and a `signal` that is `undefined` at run time
 * reads as present. A floor, not a proof.
 */
export function scanFetches(
  path: string,
  source: string,
  masked: string = maskLiterals(source),
): readonly FetchSite[] {
  if (isTestPath(path) || /-fixture\.tsx?$/.test(path) || path.endsWith('.island.tsx')) return [];
  const sites: FetchSite[] = [];
  for (const match of masked.matchAll(CALL)) {
    const open = match.index + match[0].length - 1;
    const close = balancedClose(masked, open);
    const end = close < 0 ? masked.length : close;
    const after = masked.slice(end + 1).trimStart();
    if (after.startsWith('{') || after.startsWith(':')) continue;
    if (/\bfunction\s*\*?\s*$/.test(masked.slice(0, match.index))) continue;
    if (hasSignal(masked.slice(open + 1, end))) continue;
    sites.push({
      path,
      line: lineOf(masked, match.index),
      call: match[0].replace(/\s*\($/, '').replaceAll(/\s/g, ''),
    });
  }
  return sites;
}

export type FetchGap = RatchetGap<FetchSite>;

export const checkFetches = (
  sites: readonly FetchSite[],
  pins: PinTable,
  scanned: boolean,
): readonly FetchGap[] => ratchetGaps(sites, pins, scanned);

const at = (site: FetchSite | undefined): string =>
  site === undefined ? '' : `${site.path}:${String(site.line)}`;

const overFinding = (gap: FetchGap): Finding => ({
  code: 'X_FETCH_UNBOUNDED',
  cause: `${gap.pkg} calls fetch with no signal ${String(gap.found)} time(s) and is pinned at ${String(gap.pinned)} — ${siteList(gap, (site) => `${at(site)} (${site.call})`, EXPLAIN)} — and a call with no signal outlives the request that made it`,
  fix: `bun run scripts/fetch-deadline.ts --explain --json   # then call outbound() from @ultimat3/core/outbound at ${siteTarget(gap, at)}, or pass { signal } in its options; for a call nothing can bound, raise ${gap.pkg} in FETCH_DEADLINE_PINS in ${FETCH_DEADLINE_PINS_FILE} with a why: naming what ends it`,
  at: at(leadSite(gap)),
});

const staleFinding = (gap: FetchGap): Finding => ({
  code: 'X_FETCH_DEADLINE_PIN_STALE',
  cause: `${gap.pkg} is pinned at ${String(gap.pinned)} unsignalled fetch call(s) and has ${String(gap.found)}, so the pin would let ${String(gap.pinned - gap.found)} back in`,
  fix: `bun run scripts/fetch-deadline.ts --unpin ${renderFixShellArg(gap.pkg, '<package>')}`,
  at: FETCH_DEADLINE_PINS_FILE,
});

const unexplainedFinding = (gap: FetchGap): Finding => ({
  code: 'X_FETCH_DEADLINE_PIN_UNEXPLAINED',
  cause: `${gap.pkg} is pinned with a blank reason, so nothing says what ends its ${String(gap.found)} unsignalled fetch call(s)`,
  fix: `grep -n FETCH_DEADLINE_PINS scripts/lib/fetch-deadline-pins.ts   # write in its ${gap.pkg} row what ends each unsignalled fetch, or move each to outbound() and run bun run scripts/fetch-deadline.ts --unpin ${gap.pkg}`,
  at: FETCH_DEADLINE_PINS_FILE,
});

const unscannedFinding = (): Finding => ({
  code: 'X_CORPUS_UNSCANNED',
  cause:
    'no source file was read, so every package reports zero unsignalled fetch calls and the ratchet enforces nothing',
  fix: 'grep -n PATTERNS scripts/lib/corpus.ts   # make them match this repo layout, then: bun run scripts/fetch-deadline.ts',
  at: 'scripts/lib/corpus.ts',
});

export const fetchFindingFor = (gap: FetchGap): Finding => {
  switch (gap.kind) {
    case 'over':
      return overFinding(gap);
    case 'stale':
      return staleFinding(gap);
    case 'unexplained':
      return unexplainedFinding(gap);
    case 'unscanned':
      return unscannedFinding();
  }
};

/** Every site in the tree, off the shared corpus and its CACHED mask (`spawn-timeout.ts`'s reason). */
export const fetchSites = async (root: string): Promise<readonly FetchSite[]> =>
  (await corpus(root, 'source')).flatMap((file) =>
    scanFetches(file.path, file.source, file.masked),
  );

const PROBE: SiteProbe<FetchSite> = { rescan: scanFetches, line: (site) => site.line };

export const fetchGaps = async (root: string): Promise<readonly FetchGap[]> =>
  newSitesFirst(root, checkFetches(await fetchSites(root), FETCH_DEADLINE_PINS, true), PROBE);

if (import.meta.main) {
  await ratchetMain({
    script: SCRIPT,
    pinsFile: FETCH_DEADLINE_PINS_FILE,
    pins: FETCH_DEADLINE_PINS,
    sites: fetchSites,
    findingFor: fetchFindingFor,
    probe: PROBE,
    clean: 'every shipped fetch carries a signal, or sits under its package pin',
  });
}
