#!/usr/bin/env bun
// Enforce, as a ratchet, the log-level policy on per-unit paths: an `info` line — or a computed level
// that may be one — written once per request, job, fire or message needs a `// info: <why>` on it or
// directly above. Routine per-unit events are `debug`; `info` is lifecycle and rare outcomes; `warn`
// asks an operator to act.
//   bun run scripts/log-levels.ts [--json] [--explain]  ·  bun run scripts/log-levels.ts --unpin <pkg>

// why: host-separator paths to each listed file; Bun ships no path API.
import { join } from 'node:path';
import { renderFixShellArg } from '@ultimat3/core';
import { maskLiterals } from '../packages/core/src/source-mask';
import type { Finding } from './lib/log';
import { LOG_LEVEL_PINS, LOG_LEVEL_PINS_FILE } from './lib/log-levels-pins';
import type { PinTable, RatchetGap } from './lib/ratchet';
import { ratchetGaps, ratchetMain } from './lib/ratchet';
import type { SiteProbe } from './lib/ratchet-sites';
import { leadSite, newSitesFirst, siteList, siteTarget } from './lib/ratchet-sites';
import { lineOf } from './lib/source-scan';

const SCRIPT = 'log-levels';
const EXPLAIN = 'bun run scripts/log-levels.ts --explain --json lists every one';

/**
 * The files whose code runs once per unit of work, each with the unit. A scheduler pod's lines were
 * 88% `jobs.scheduler.dispatched` at `info` (production, 2026-11) before this list existed. A Map,
 * never an object literal: a path is data (`proto-index`).
 */
export const PER_UNIT_FILES: ReadonlyMap<string, string> = new Map([
  ['packages/http/src/pipeline.ts', 'request'],
  ['packages/http/src/stages.ts', 'request'],
  ['packages/http/src/admit-stage.ts', 'request'],
  ['packages/http/src/cache-stage.ts', 'request'],
  ['packages/http/src/rate-limit-stage.ts', 'request'],
  ['packages/http/src/refusal-log.ts', 'request'],
  ['packages/http/src/server.ts', 'request'],
  ['packages/action/src/invoke.ts', 'action call'],
  ['packages/query/src/read.ts', 'query read'],
  ['packages/jobs/src/scheduler.ts', 'task fire'],
  ['packages/jobs/src/worker.ts', 'job claim'],
  ['packages/jobs/src/execute.ts', 'job attempt'],
  ['packages/jobs/src/heartbeat.ts', 'job lease'],
  ['packages/jobs/src/worker-key-busy.ts', 'job attempt'],
  ['packages/mcp/src/audit-hook.ts', 'tool call'],
  ['packages/mcp/src/transport-http.ts', 'MCP request'],
  ['packages/realtime/src/page-socket.ts', 'socket frame'],
  ['packages/realtime/src/client-frames.ts', 'socket frame'],
  ['packages/mail/src/driver.ts', 'message sent'],
  ['packages/notify/src/native-push.ts', 'push sent'],
  ['packages/scraping/src/scrape-run.ts', 'scrape run'],
]);

/**
 * `logger.info`, `log.info`, `ctx.log?.info`, a line break before the dot included — called, or
 * taken as a value (`const say = logger.info`), because an alias writes the same line.
 */
const INFO_MEMBER = /(?<![\w$])(?:logger|log)\s*\??\.\s*info(?![\w$])/g;
/**
 * `logger[level]`, `log?.['info']`: a COMPUTED level may be `info` (`stages.ts`'s error-map line
 * is `refusalLogLevel()`'s answer), and nothing short of running it says which, so it states why
 * too. Only a literal naming another level (`logger['debug']`) is known not to be `info`.
 */
const COMPUTED_MEMBER = /(?<![\w$])(?:logger|log)\s*(?:\?\.)?\s*\[/g;
/** The index of a computed member when it is a literal level: `'debug']`. */
const LITERAL_INDEX = /^\s*(['"`])(\w*)\1\s*\]/;
/** A call opening right after the member: `(`, or `?.(`. */
const CALL = /^\s*(?:\?\.)?\s*\(/;
/** The stated reason: a `// info:` followed by at least one word. */
const STATED = /\/\/\s*info:\s*\S/;
/** The event a call writes: its first argument, when that is a literal. */
const EVENT = /^\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/;

export interface InfoSite {
  readonly path: string;
  readonly line: number;
  /** The first argument as written, or `?` when it is not a literal or the member is not called. */
  readonly event: string;
}

/** Index just past the `]` closing the computed member whose `[` ends at `open`, in masked text. */
const closeOf = (masked: string, open: number): number => {
  let depth = 1;
  for (let i = open; i < masked.length; i += 1) {
    if (masked[i] === '[') depth += 1;
    else if (masked[i] === ']' && --depth === 0) return i + 1;
  }
  return masked.length;
};

/** Where each member that may write `info` ends, keyed by its start; a literal other level is absent. */
const memberEnds = (source: string, masked: string): ReadonlyMap<number, number> => {
  const ends = new Map<number, number>();
  for (const match of masked.matchAll(INFO_MEMBER)) {
    ends.set(match.index, match.index + match[0].length);
  }
  for (const match of masked.matchAll(COMPUTED_MEMBER)) {
    const open = match.index + match[0].length;
    const literal = LITERAL_INDEX.exec(source.slice(open));
    if (literal !== null && literal[2] !== 'info') continue;
    ends.set(match.index, literal === null ? closeOf(masked, open) : open + literal[0].length);
  }
  return ends;
};

/** Every unstated `info` call in `source`, read as `path`; a file off the list has none. */
export function scanInfoLines(path: string, source: string): readonly InfoSite[] {
  if (!PER_UNIT_FILES.has(path)) return [];
  const masked = maskLiterals(source);
  const lines = source.split('\n');
  const sites: InfoSite[] = [];
  const ends = memberEnds(source, masked);
  for (const start of [...ends.keys()].sort((a, b) => a - b)) {
    const line = lineOf(masked, start);
    const here = lines[line - 1] ?? '';
    const above = (lines[line - 2] ?? '').trim();
    if (STATED.test(here) || (above.startsWith('//') && STATED.test(above))) continue;
    const rest = source.slice(ends.get(start));
    const call = CALL.exec(rest);
    const event = call === null ? '?' : (EVENT.exec(rest.slice(call[0].length))?.[2] ?? '?');
    sites.push({ path, line, event });
  }
  return sites;
}

export type InfoGap = RatchetGap<InfoSite>;

export const checkLogLevels = (
  sites: readonly InfoSite[],
  pins: PinTable,
  scanned: boolean,
): readonly InfoGap[] => ratchetGaps(sites, pins, scanned);

const at = (site: InfoSite | undefined): string =>
  site === undefined ? '' : `${site.path}:${String(site.line)}`;

const overFinding = (gap: InfoGap): Finding => ({
  code: 'X_LOG_LEVEL_UNSTATED',
  cause: `${gap.pkg} writes ${String(gap.found)} info line(s) on a per-unit path with no stated reason and is pinned at ${String(gap.pinned)} — ${siteList(gap, (site) => `${at(site)} (${site.event})`, EXPLAIN)} — and a routine line per request, job or fire is what fills a pod's logs`,
  fix: `bun run scripts/log-levels.ts --explain --json   # then at ${siteTarget(gap, at)} write logger.debug for a routine event, or put // info: <why it is lifecycle or a rare outcome> on the line above`,
  at: at(leadSite(gap)),
});

const staleFinding = (gap: InfoGap): Finding => ({
  code: 'X_LOG_LEVEL_PIN_STALE',
  cause: `${gap.pkg} is pinned at ${String(gap.pinned)} unstated info line(s) and has ${String(gap.found)}, so the pin would let ${String(gap.pinned - gap.found)} back in`,
  fix: `bun run scripts/log-levels.ts --unpin ${renderFixShellArg(gap.pkg, '<package>')}`,
  at: LOG_LEVEL_PINS_FILE,
});

const unexplainedFinding = (gap: InfoGap): Finding => ({
  code: 'X_LOG_LEVEL_PIN_UNEXPLAINED',
  cause: `${gap.pkg} is pinned with a blank reason, so nothing says why its ${String(gap.found)} per-unit info line(s) are news`,
  fix: `grep -n LOG_LEVEL_PINS ${LOG_LEVEL_PINS_FILE}   # write in its ${gap.pkg} row why each line is lifecycle or a rare outcome, or demote them and run bun run scripts/log-levels.ts --unpin ${gap.pkg}`,
  at: LOG_LEVEL_PINS_FILE,
});

const unscannedFinding = (): Finding => ({
  code: 'X_CORPUS_UNSCANNED',
  cause:
    'no per-unit file was read, so every package reports zero info lines and the ratchet enforces nothing',
  fix: 'grep -n PER_UNIT_FILES scripts/log-levels.ts   # make the paths match this repo layout, then: bun run scripts/log-levels.ts',
  at: 'scripts/log-levels.ts',
});

export const logLevelFindingFor = (gap: InfoGap): Finding => {
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

/** Every unstated site across the listed files; a missing file reads as nothing (the test lists it). */
export async function infoSites(root: string): Promise<readonly InfoSite[]> {
  const found: InfoSite[] = [];
  for (const path of PER_UNIT_FILES.keys()) {
    const file = Bun.file(join(root, path));
    if (await file.exists()) found.push(...scanInfoLines(path, await file.text()));
  }
  return found;
}

const PROBE: SiteProbe<InfoSite> = { rescan: scanInfoLines, line: (site) => site.line };

export const logLevelGaps = async (root: string): Promise<readonly InfoGap[]> =>
  newSitesFirst(root, checkLogLevels(await infoSites(root), LOG_LEVEL_PINS, true), PROBE);

if (import.meta.main) {
  await ratchetMain({
    script: SCRIPT,
    pinsFile: LOG_LEVEL_PINS_FILE,
    pins: LOG_LEVEL_PINS,
    sites: infoSites,
    findingFor: logLevelFindingFor,
    probe: PROBE,
    clean: 'every per-unit info line states why it is news, or sits under its package pin',
  });
}
