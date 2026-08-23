// `x shot --island <name>` — one component, in the states it declares, photographed one address at
// a time. The order matters and is the whole design: the complete expected picture list is
// computed from the states file BEFORE a browser exists, and what landed on disk is diffed against
// that list afterwards, so "produced nothing and exited 0" is a state this command can refuse.

// why: no Bun native joins a path; `Bun.write` and `Bun.file` both take one already joined.
import { join } from 'node:path';
import type { ScrapeDriver, ScrapeSession } from '@ultimat3/scraping';
import { systemScrapeClock } from '@ultimat3/scraping';
import type { IslandShotTarget, IslandStatesManifest, IslandViewport } from '@ultimat3/testing';
import { islandShotTargets, islandStatesFile } from '@ultimat3/testing';
import { ISLAND_HARNESS_PATH } from './island-harness';
import { readinessProbe } from './island-harness-script';
import {
  IslandRequestUnstubbedError,
  IslandShotsMissingError,
  IslandUnphotographableError,
} from './island-shot-errors';
import type { IslandArtifacts, IslandReadiness, IslandStateShot } from './island-verdict';
import { buildIslandVerdict, islandVerdictJson, parseReadiness } from './island-verdict';
import type { ShotServer } from './shot-server';
import { allowHostsFrom } from './shot-server';
import { SETTLE_POLL_MS, settleReadiness } from './shot-settle';

/** Where a component's pictures land, under the same `.x/shot` tree a route's picture does. */
export const ISLAND_SHOT_DIR = 'island';
export const ISLAND_VERDICT = 'verdict.json';

/**
 * A backstop and not a quality bar: it catches the answers that are not an image at all — a driver
 * that hands back a handshake, an empty buffer, a PNG signature with nothing behind it. A real
 * capture of any viewport clears it by an order of magnitude.
 */
export const MIN_SHOT_BYTES = 512;

/**
 * A browser sized to one viewport. A FUNCTION and not a driver, because the shipped browser port
 * takes the viewport as a LAUNCH option (`LocalBrowserOptions.options`) and a state declares its
 * own — so "photograph this state at 480x320" is a different browser, not a different call.
 */
export type IslandBrowser = (viewport: IslandViewport) => Promise<ScrapeDriver>;

export interface IslandShotRun {
  readonly manifest: IslandStatesManifest;
  /**
   * `--state`, or every declared state when absent. The caller validates it: `defineIslandStates`
   * refuses a manifest with no states, so the only way this expansion comes back empty is a filter
   * naming a state that does not exist — which is a typo, and belongs to the flag that made it.
   */
  readonly state?: string | undefined;
  readonly outDir: string;
  readonly driver: IslandBrowser;
  readonly boot: () => Promise<ShotServer>;
  readonly settleMs: number;
  readonly timeoutMs: number;
  readonly extraHosts?: string | undefined;
  readonly minBytes?: number | undefined;
  readonly now?: (() => Date) | undefined;
}

const quietly = async (stop: () => Promise<void>): Promise<void> => {
  await stop().catch(() => undefined);
};

/**
 * Every assertion that has to hold before a shutter opens, in the order a failure is most useful
 * in. Each one names a fact the picture would have hidden rather than shown: an absent harness is
 * a dev server that does not know this island, an unattached host photographs the frame's
 * background, a zero box photographs whatever is behind it, and an empty box is a component that
 * mounted and rendered nothing — every one of which comes out as a plausible image of the wrong
 * thing.
 */
interface Refusal {
  readonly reason: string;
  readonly fix: string;
}

/**
 * The first assertion that does not hold, in the order a failure is most useful in — or
 * `undefined`, which is the only way a shutter opens. Each clause names a fact the picture would
 * have hidden rather than shown: an absent harness is a dev server that does not know this island,
 * an unattached host photographs the frame's background, a zero box photographs whatever is behind
 * it, and an empty box is a component that mounted and rendered nothing. Every one of them comes
 * out as a plausible image of the wrong thing.
 *
 * A value and not a throw, so the whole ladder is one pure function a test can walk.
 */
export function photographFault(
  target: IslandShotTarget,
  seen: IslandReadiness | null,
): Refusal | undefined {
  const settle = `x shot --island ${target.name} --settle 8000 --json`;
  if (seen === null) {
    return {
      reason: 'answered no readiness probe at all, so nothing about the page can be asserted',
      fix: `x shot --island ${target.name} --state ${target.state} --timeout 60000 --json`,
    };
  }
  if (!seen.harness) {
    return {
      reason:
        'was served a document that is not the shot harness — the dev server this run reused was booted against a different set of states files',
      fix: 'restart x dev, then run this command again',
    };
  }
  if (!seen.attached) {
    return { reason: 'rendered no [data-x-island] host element', fix: hostFix(target) };
  }
  if (seen.failed !== null) {
    return {
      reason: `mounted and its mount() REJECTED: ${seen.failed}`,
      fix: `x shot --island ${target.name} --state ${target.state} --json   # the verdict carries the throw and its frame`,
    };
  }
  if (!seen.mounted) {
    return { reason: 'did not finish mounting inside the settle window', fix: settle };
  }
  if (!seen.ready) {
    return {
      reason:
        'never went quiet: something kept starting or settling requests for the whole settle window',
      fix: settle,
    };
  }
  if (seen.box.width === 0 || seen.box.height === 0) {
    return {
      reason: `has a ${seen.box.width}x${seen.box.height} bounding box, so the picture would be of whatever is behind it`,
      fix: cropFix(target),
    };
  }
  if (!seen.filled) {
    return {
      reason:
        'has a box with no child elements and no text in it — it mounted and rendered nothing',
      fix: cropFix(target),
    };
  }
  return undefined;
}

const hostFix = (target: IslandShotTarget): string =>
  `in ${islandStatesFile(target.island)} set island to a path that exports mount(el, props)`;

const cropFix = (target: IslandShotTarget): string =>
  `in ${islandStatesFile(target.island)} set target to a selector the component really renders, or widen the state's props`;

/**
 * One address, one full page load, one picture. Never a client-side switch between states: the
 * previous state's fixtures, its resolved resources and its mounted DOM would ride into the next
 * picture, which is the one way a screenshot tool can lie about its own subject.
 *
 * A session PER TARGET, and it costs a browser launch each: `page.console()` and `page.pageErrors()`
 * are bounded rings over the whole SESSION, so a shared one would file state A's console errors
 * under state B — and per-state attribution is the half of this artifact that gates.
 */
async function captureOne(
  options: IslandShotRun,
  server: ShotServer,
  target: IslandShotTarget,
): Promise<IslandStateShot> {
  const url = new URL(`${ISLAND_HARNESS_PATH}${target.query}`, server.url).toString();
  let session: ScrapeSession | undefined;
  try {
    const driver = await options.driver(target.viewport);
    session = await driver.open({
      name: 'x shot --island',
      rules: { allowHosts: allowHostsFrom(server.url, options.extraHosts) },
      clock: systemScrapeClock,
      timeoutMs: options.timeoutMs,
    });
    const page = session.page;
    await page.goto(url, { timeout: options.timeoutMs });
    const expression = readinessProbe(target.target ?? '[data-x-island]');
    const probe = (): Promise<IslandReadiness | null> =>
      page
        .evaluate(expression)
        .then(parseReadiness)
        .catch(() => null);
    const seen = await settleReadiness(probe, {
      windowMs: options.settleMs,
      pollMs: SETTLE_POLL_MS,
    });
    // Ahead of every other assertion about the picture: a component whose fetch went unanswered
    // paints its own loading branch, and the picture then shows a fixture gap dressed up as a
    // real component state. The list is the page's own, published by the seal.
    if (seen !== null && seen.unstubbed.length > 0) {
      throw new IslandRequestUnstubbedError({
        island: target.island,
        state: target.state,
        requests: seen.unstubbed,
        statesFile: islandStatesFile(target.island),
      });
    }
    const fault = photographFault(target, seen);
    if (fault !== undefined) {
      throw new IslandUnphotographableError({
        island: target.island,
        state: target.state,
        theme: target.theme,
        ...fault,
      });
    }
    // Never `fullPage`: the frame is the state's own declared viewport, and a full-page capture
    // would grow with whatever the component scrolled.
    const bytes = await page.screenshot({ fullPage: false });
    const floor = options.minBytes ?? MIN_SHOT_BYTES;
    if (bytes.byteLength < floor) {
      throw new IslandUnphotographableError({
        island: target.island,
        state: target.state,
        theme: target.theme,
        reason: `produced ${bytes.byteLength} bytes, under the ${floor}-byte floor — that is not an image`,
        fix: `x shot --island ${target.name} --browser /usr/bin/chromium --json`,
      });
    }
    await Bun.write(join(options.outDir, target.file), bytes);
    return {
      state: target.state,
      theme: target.theme,
      file: target.file,
      bytes: bytes.byteLength,
      box: seen?.box ?? { x: 0, y: 0, width: 0, height: 0 },
      mounted: seen?.mounted === true,
      unstubbed: seen?.unstubbed ?? [],
      console: page.console(),
      pageErrors: page.pageErrors(),
    };
  } finally {
    const open = session;
    if (open !== undefined) await quietly(() => open.close());
  }
}

/** Declared pictures that are not on disk. Read from the EXPANSION, never from the loop's beliefs. */
export async function missingShots(
  outDir: string,
  expected: readonly IslandShotTarget[],
): Promise<readonly string[]> {
  const missing: string[] = [];
  for (const target of expected) {
    if (!(await Bun.file(join(outDir, target.file)).exists())) missing.push(target.file);
  }
  return missing;
}

/**
 * Boot (or find) the server, photograph every declared state, write the pictures and the verdict,
 * then refuse if any declared picture is absent. The driver and the boot are ARGUMENTS for the
 * reason `runShot`'s are: `bun test` drives this with a fake browser and a stub server, so the
 * whole command is proved on a machine with no Chrome.
 */
export async function runIslandShot(options: IslandShotRun): Promise<IslandArtifacts> {
  // A Set and not an `===`: `bun run secret-compare` reads the NAME of a comparison's operands and
  // `state` is on its list, because an OAuth handshake state is compared under exactly that name.
  // This one is a screenshot filename stem, and the membership test says so.
  const chosen = options.state === undefined ? null : new Set([options.state]);
  const targets = islandShotTargets(options.manifest).filter(
    (target) => chosen === null || chosen.has(target.state),
  );
  const server = await options.boot();
  const shots: IslandStateShot[] = [];
  const failures: unknown[] = [];
  try {
    for (const target of targets) {
      // A state that cannot be photographed does not stop the run: the reader wants every picture
      // the app CAN produce plus a named reason for each one it cannot, and the missing-shot gate
      // below is what turns those reasons into a non-zero exit.
      try {
        shots.push(await captureOne(options, server, target));
      } catch (error) {
        failures.push(error);
      }
    }
  } finally {
    await quietly(() => server.stop());
  }
  const missing = await missingShots(options.outDir, targets);
  const verdict = buildIslandVerdict({
    island: options.manifest.island,
    name: options.manifest.name,
    server: server.origin,
    capturedAt: (options.now ?? (() => new Date()))().toISOString(),
    expected: targets,
    shots,
    missing,
  });
  const dir = join(options.outDir, options.manifest.name);
  const verdictFile = join(dir, ISLAND_VERDICT);
  await Bun.write(verdictFile, `${JSON.stringify(islandVerdictJson(verdict), null, 2)}\n`);
  // The first failure is re-thrown ONLY when it explains a missing picture. A run that took every
  // declared picture and also logged a failure is a contradiction; the artifact is what decides.
  if (missing.length > 0) {
    const first = failures[0];
    if (first !== undefined) throw first;
    throw new IslandShotsMissingError({
      island: options.manifest.name,
      missing,
      expected: targets.length,
      dir,
    });
  }
  return { verdict, dir, verdictFile };
}
