// `--island`'s half of `x shot`: read the flags, resolve the manifest, refuse the combinations
// that cannot mean anything, and hand `runIslandShot` values. Split from `cmd-shot.ts` so neither
// file has to hold both a route capture and a component capture — the two share a boot, a browser
// and an output tree, and nothing else.

// why: no Bun native joins or resolves a path; `--out` is resolved against the app root.
import { join, resolve } from 'node:path';
import type { ScrapeDriver } from '@ultimat3/scraping';
import type { IslandStatesManifest, IslandViewport } from '@ultimat3/testing';
import { findIslandStates } from '@ultimat3/testing';
import { appBrowser } from './browser-launcher';
import { BadFlagError } from './errors';
import type { IslandBrowser } from './island-shot';
import { ISLAND_SHOT_DIR, runIslandShot } from './island-shot';
import { loadIslandStates } from './island-states-load';
import type { IslandArtifacts } from './island-verdict';
import { islandShotLines, islandShotSummary, islandVerdictJson } from './island-verdict';
import type { CommandResult } from './output';
import type { ShotServer } from './shot-server';
import { SHOT_DIR } from './shot-server';

/**
 * One browser per declared viewport, memoised. A state declares its own size and the viewport is a
 * LAUNCH option, so two states at two sizes are two browsers — but two states at one size must not
 * be, or a manifest of eight states pays eight launches for nothing.
 */
export function islandBrowser(input: {
  readonly root: string;
  readonly executablePath?: string | undefined;
  readonly cdpUrl?: string | undefined;
}): IslandBrowser {
  const byViewport = new Map<string, Promise<ScrapeDriver>>();
  return (viewport: IslandViewport): Promise<ScrapeDriver> => {
    const key = `${viewport.width}x${viewport.height}`;
    const held = byViewport.get(key);
    if (held !== undefined) return held;
    const started = appBrowser({
      root: input.root,
      ...(input.executablePath === undefined ? {} : { executablePath: input.executablePath }),
      ...(input.cdpUrl === undefined ? {} : { cdpUrl: input.cdpUrl }),
      viewport: { width: viewport.width, height: viewport.height },
    });
    byViewport.set(key, started);
    return started;
  };
}

/**
 * `--state <id>` against what the manifest really declares. Refused here rather than by an empty
 * expansion downstream: a filter that matches nothing produces no picture, and a run that produces
 * no picture and exits 0 is the outcome this whole command exists to make impossible.
 */
export function readStateFlag(
  manifest: IslandStatesManifest,
  wanted: string | undefined,
): string | undefined {
  if (wanted === undefined || wanted === '') return undefined;
  if (manifest.states.some((one) => one.id === wanted)) return wanted;
  const known = manifest.states.map((one) => one.id);
  throw new BadFlagError({
    flag: 'state',
    command: 'shot',
    reason: `${manifest.island} declares no state "${wanted}" — it declares ${known.join(', ')}`,
    fix: `x shot --island ${manifest.name} --state ${known[0] ?? '<id>'} --json`,
  });
}

/**
 * `--island` and a route positional are two different subjects and one command, so naming both is
 * refused by name. Never silently preferring one: a reader who typed both has a belief about which
 * one runs, and half of them would be wrong.
 */
export function refuseRouteWithIsland(route: string | undefined, island: string): never {
  throw new BadFlagError({
    flag: 'island',
    command: 'shot',
    reason: `--island ${island} photographs a component and "${route ?? ''}" is a route; x shot takes one subject`,
    fix: `x shot --island ${island} --json`,
  });
}

export interface IslandShotInput {
  readonly root: string;
  readonly island: string;
  readonly state?: string | undefined;
  readonly out?: string | undefined;
  readonly settleMs: number;
  readonly timeoutMs: number;
  readonly extraHosts?: string | undefined;
  readonly executablePath?: string | undefined;
  /** A provider's session, or a sidecar. One attach per viewport, memoised like a launch. */
  readonly cdpUrl?: string | undefined;
  readonly boot: () => Promise<ShotServer>;
  /** Injected by a test, so the whole path is proved on a machine with no Chrome. */
  readonly driver?: IslandBrowser | undefined;
  readonly minBytes?: number | undefined;
}

/**
 * The states are loaded, expanded and the name resolved BEFORE a browser or a dev server exists —
 * a typo must not cost an embedded Postgres to report, and the expected picture list has to be
 * knowable without either.
 */
export async function islandShot(input: IslandShotInput): Promise<IslandArtifacts> {
  const all = await loadIslandStates(input.root);
  if (all.length === 0) {
    throw new BadFlagError({
      flag: 'island',
      command: 'shot',
      reason: 'this app declares no island states at all, so there is nothing to photograph',
      fix: "x g island settings --at apps/web/app/settings   # then declare its states beside it with defineIslandStates({ island: '…', states: [...] })",
    });
  }
  // `findIslandStates` is loose on the way in — `Settings`, `settings`, `settings.island.tsx` and
  // the full path are one name — and refuses an unresolved one by listing every valid name, which
  // is what tells a typo apart from an island whose states were never declared.
  const manifest = findIslandStates(all, input.island);
  const only = readStateFlag(manifest, input.state);
  return runIslandShot({
    manifest,
    ...(only === undefined ? {} : { state: only }),
    outDir:
      input.out === undefined
        ? join(input.root, SHOT_DIR, ISLAND_SHOT_DIR)
        : resolve(input.root, input.out),
    driver:
      input.driver ??
      islandBrowser({
        root: input.root,
        ...(input.executablePath === undefined ? {} : { executablePath: input.executablePath }),
        ...(input.cdpUrl === undefined ? {} : { cdpUrl: input.cdpUrl }),
      }),
    boot: input.boot,
    settleMs: input.settleMs,
    timeoutMs: input.timeoutMs,
    ...(input.extraHosts === undefined ? {} : { extraHosts: input.extraHosts }),
    ...(input.minBytes === undefined ? {} : { minBytes: input.minBytes }),
  });
}

export const islandShotResult = (artifacts: IslandArtifacts): CommandResult => ({
  ok: artifacts.verdict.ok,
  command: 'shot',
  summary: islandShotSummary(artifacts.verdict),
  lines: islandShotLines(artifacts),
  data: {
    dir: artifacts.dir,
    verdictFile: artifacts.verdictFile,
    verdict: islandVerdictJson(artifacts.verdict),
  },
});
