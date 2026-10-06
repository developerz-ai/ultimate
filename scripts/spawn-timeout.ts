#!/usr/bin/env bun
// Enforce, as a ratchet, that a child process this tree waits on carries a deadline: a `timeout`
// (or an abort `signal`) in its options. An untimed child that hangs hangs its parent with it, and
// a synchronous wait cannot even be interrupted by a test's own timeout — the gate sat on one.
// Bun's shell (`Bun.$`, or `$` imported from `'bun'`) spawns a child too and takes no deadline, so
// every shell call in shipped source is a site — a pin with its sentence, or a `Bun.spawn` instead.
//   bun run spawn-timeout [--json] [--explain]  ·  bun run scripts/spawn-timeout.ts --unpin <pkg>

import { renderFixShellArg } from '@ultimat3/core';
import { maskLiterals } from '../packages/core/src/source-mask';
import { balancedClose } from './lib/balanced-paren';
import { corpus } from './lib/corpus';
import type { Finding } from './lib/log';
import type { PinTable, RatchetGap } from './lib/ratchet';
import { ratchetGaps, ratchetMain } from './lib/ratchet';
import type { SiteProbe } from './lib/ratchet-sites';
import { leadSite, newSitesFirst, siteList, siteTarget } from './lib/ratchet-sites';
import { isTestPath, lineOf } from './lib/source-scan';
import { SPAWN_TIMEOUT_PINS, SPAWN_TIMEOUT_PINS_FILE } from './lib/spawn-timeout-pins';

const SCRIPT = 'spawn-timeout';
const EXPLAIN = 'bun run scripts/spawn-timeout.ts --explain --json lists every one';

/** The calls that block until the child exits. Bare names cover a `node:child_process` import. */
const SYNC_CALL = /(?<![\w$])(?:Bun\.spawnSync|spawnSync|execSync|execFileSync)\s*\(/g;
const ASYNC_CALL = /(?<![\w$])Bun\.spawn\s*\(/g;

/** A deadline key: `timeout: n`, `signal: s`, or either as shorthand. */
const DEADLINE = /(?<![\w$.])(?:timeout|signal)\s*[:,}]/g;

/** `Bun.$` followed by its template, and the names an import from `'bun'` binds `$` to. */
const BUN_SHELL = /(?<![\w$])Bun\s*\.\s*\$\s*`/g;
const BUN_IMPORT = /\bimport\s*\{([^}]*)\}\s*from\s*['"]bun['"]/g;

/**
 * Whether one of the call's OWN options is a deadline: the key must sit directly inside an object
 * at the arguments' top level. `{ env: { timeout: '5' } }` names a variable the child reads, and
 * read as the call's deadline it waved an untimed child through (sweep 11).
 */
const hasDeadline = (args: string): boolean => {
  for (const match of args.matchAll(DEADLINE)) {
    const opened: string[] = [];
    for (const char of args.slice(0, match.index)) {
      if (char === '{' || char === '[' || char === '(') opened.push(char);
      else if (char === '}' || char === ']' || char === ')') opened.pop();
    }
    if (opened.length === 1 && opened[0] === '{') return true;
  }
  return false;
};

/** Every local name the file's imports from `'bun'` give the shell: `$`, or its alias. */
const shellNames = (masked: string, source: string): readonly string[] => {
  const names: string[] = [];
  for (const match of source.matchAll(BUN_IMPORT)) {
    if (masked[match.index] !== 'i') continue;
    for (const part of (match[1] ?? '').split(',')) {
      const spec = /^\$(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(part.trim());
      if (spec !== null) names.push(spec[1] ?? '$');
    }
  }
  return names;
};

export interface SpawnSite {
  readonly path: string;
  readonly line: number;
  /** The call as written, up to its `(` — `Bun.spawnSync`, `Bun.spawn`. */
  readonly call: string;
}

/**
 * Every untimed spawn in one file. TWO SHAPES, TWO SCOPES: a synchronous spawn blocks the event
 * loop until the child exits, so it is read everywhere, tests included. `Bun.spawn` is read in
 * shipped source only — a test's `Bun.spawn` + awaited `exited` is the house shape, bounded by the
 * test timeout — and a long-lived child its caller kills (a dev server, an editor, a forwarded CLI)
 * is a pin with its sentence, never a silent pass.
 *
 * WHAT IT CANNOT SEE: options passed as a variable (`Bun.spawn(cmd, options)`) read as untimed, and
 * a `timeout` that is `undefined` at run time reads as timed — and so does a `signal` that is no
 * `AbortSignal` bounding the child, since only the property NAME is read. A floor, not a proof.
 */
export function scanSpawns(path: string, source: string): readonly SpawnSite[] {
  const masked = maskLiterals(source);
  const shipped = !isTestPath(path);
  const sites: SpawnSite[] = [];
  const read = (pattern: RegExp): void => {
    for (const match of masked.matchAll(pattern)) {
      const open = match.index + match[0].length - 1;
      const close = balancedClose(masked, open);
      const args = masked.slice(open + 1, close < 0 ? masked.length : close);
      if (hasDeadline(args)) continue;
      sites.push({ path, line: lineOf(masked, match.index), call: match[0].replace(/\s*\($/, '') });
    }
  };
  read(SYNC_CALL);
  if (shipped) {
    read(ASYNC_CALL);
    const shell = (pattern: RegExp, call: string): void => {
      for (const match of masked.matchAll(pattern)) {
        sites.push({ path, line: lineOf(masked, match.index), call });
      }
    };
    shell(BUN_SHELL, 'Bun.$');
    for (const name of shellNames(masked, source)) {
      shell(new RegExp(`(?<![\\w$.])${RegExp.escape(name)}\\s*\``, 'g'), name);
    }
  }
  return sites.sort((a, b) => a.line - b.line);
}

export type SpawnGap = RatchetGap<SpawnSite>;

export const checkSpawns = (
  sites: readonly SpawnSite[],
  pins: PinTable,
  scanned: boolean,
): readonly SpawnGap[] => ratchetGaps(sites, pins, scanned);

const at = (site: SpawnSite | undefined): string =>
  site === undefined ? '' : `${site.path}:${String(site.line)}`;

const overFinding = (gap: SpawnGap): Finding => ({
  code: 'X_SPAWN_UNTIMED',
  cause: `${gap.pkg} spawns ${String(gap.found)} child process(es) with no timeout and is pinned at ${String(gap.pinned)} — ${siteList(gap, (site) => `${at(site)} (${site.call})`, EXPLAIN)} — and a child that hangs hangs whatever waits on it, the gate included`,
  fix: `add a timeout, in milliseconds, to the options of the call at ${siteTarget(gap, at)}; for a child its caller kills itself, raise ${gap.pkg} in SPAWN_TIMEOUT_PINS in ${SPAWN_TIMEOUT_PINS_FILE} with a why: naming who ends it`,
  at: at(leadSite(gap)),
});

const staleFinding = (gap: SpawnGap): Finding => ({
  code: 'X_SPAWN_TIMEOUT_PIN_STALE',
  cause: `${gap.pkg} is pinned at ${String(gap.pinned)} untimed spawn(s) and has ${String(gap.found)}, so the pin would let ${String(gap.pinned - gap.found)} back in`,
  fix: `bun run scripts/spawn-timeout.ts --unpin ${renderFixShellArg(gap.pkg, '<package>')}`,
  at: SPAWN_TIMEOUT_PINS_FILE,
});

const unexplainedFinding = (gap: SpawnGap): Finding => ({
  code: 'X_SPAWN_TIMEOUT_PIN_UNEXPLAINED',
  cause: `${gap.pkg} is pinned with a blank reason, so nothing says who ends its ${String(gap.found)} untimed child process(es)`,
  fix: `write, in ${SPAWN_TIMEOUT_PINS_FILE}, what ends each untimed child in ${gap.pkg} — or add timeout: to each and run bun run scripts/spawn-timeout.ts --unpin ${gap.pkg}`,
  at: SPAWN_TIMEOUT_PINS_FILE,
});

/** `corpus` already throws below its floor; this is the ratchet's own empty-input answer. */
const unscannedFinding = (): Finding => ({
  code: 'X_CORPUS_UNSCANNED',
  cause:
    'no source file was read, so every package reports zero untimed spawns and the ratchet enforces nothing',
  fix: 'edit PATTERNS in scripts/lib/corpus.ts so it matches this repo layout, then bun run scripts/spawn-timeout.ts',
  at: 'scripts/lib/corpus.ts',
});

export const spawnFindingFor = (gap: SpawnGap): Finding => {
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

export const spawnSites = async (root: string): Promise<readonly SpawnSite[]> =>
  (await corpus(root, 'source')).flatMap((file) => scanSpawns(file.path, file.source));

const PROBE: SiteProbe<SpawnSite> = { rescan: scanSpawns, line: (site) => site.line };

export const spawnGaps = async (root: string): Promise<readonly SpawnGap[]> =>
  newSitesFirst(root, checkSpawns(await spawnSites(root), SPAWN_TIMEOUT_PINS, true), PROBE);

if (import.meta.main) {
  await ratchetMain({
    script: SCRIPT,
    pinsFile: SPAWN_TIMEOUT_PINS_FILE,
    pins: SPAWN_TIMEOUT_PINS,
    sites: spawnSites,
    findingFor: spawnFindingFor,
    probe: PROBE,
    clean:
      'every child process this tree waits on carries a timeout, or sits under its package pin',
  });
}
