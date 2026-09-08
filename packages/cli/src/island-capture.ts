// One picture: the assertions that must hold before the shutter opens, the rectangle it opens on,
// and the one session it opens in. Split from `island-shot.ts` so that file holds the RUN — which
// islands, which order, which artifacts — and this one holds what happens at a single address.

// why: no Bun native joins a path; `Bun.write` takes one already joined.
import { join } from 'node:path';
import { finiteCount } from '@ultimat3/core';
import type { CaptureClip, ScrapeDriver, ScrapeSession } from '@ultimat3/scraping';
import { systemScrapeClock } from '@ultimat3/scraping';
import type { IslandShotTarget, IslandViewport } from '@ultimat3/testing';
import { islandStatesFile } from '@ultimat3/testing';
import { ISLAND_HARNESS_PATH } from './island-harness';
import { readinessProbe } from './island-harness-script';
import { IslandRequestUnstubbedError, IslandUnphotographableError } from './island-shot-errors';
import type { IslandReadiness, IslandStateShot } from './island-verdict';
import { parseReadiness } from './island-verdict';
import type { ShotServer } from './shot-server';
import { allowHostsFrom } from './shot-server';
import { SETTLE_POLL_MS, settleReadiness } from './shot-settle';

/**
 * A backstop and not a quality bar: it catches the answers that are not an image at all — a driver
 * that hands back a handshake, an empty buffer, a PNG signature with nothing behind it. A real
 * capture of any viewport clears it by an order of magnitude.
 */
export const MIN_SHOT_BYTES = 512;

/**
 * Page pixels kept on every side of the crop target.
 *
 * The clip was the readiness box EXACTLY, with no margin, and a pixel-tight rectangle shaves off
 * the half of a component's appearance that lives outside its border box: a `box-shadow`, an
 * `outline`, a focus ring, a hairline border that lands on a subpixel. The reviewer then reads a
 * component with no elevation as flat, which is a change the component never made.
 *
 * Small deliberately, and clamped to the page: the frame is still the COMPONENT, not the viewport
 * it happens to sit in, which is the crop this feature exists for.
 */
export const ISLAND_CROP_MARGIN_PX = 8;

/**
 * A browser sized to one viewport. A FUNCTION and not a driver, because the shipped browser port
 * takes the viewport as a LAUNCH option (`LocalBrowserOptions.options`) and a state declares its
 * own — so "photograph this state at 480x320" is a different browser, not a different call.
 */
export type IslandBrowser = (viewport: IslandViewport) => Promise<ScrapeDriver>;

interface Refusal {
  readonly reason: string;
  readonly fix: string;
}

const hostFix = (target: IslandShotTarget): string =>
  `in ${islandStatesFile(target.island)} set island to a path that exports mount(el, props)`;

const cropFix = (target: IslandShotTarget): string =>
  `in ${islandStatesFile(target.island)} set target to a selector the component really renders, or widen the state's props`;

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

/**
 * The capture rectangle for a readiness answer, in PAGE coordinates: the crop target's own box,
 * translated out of the viewport coordinates `getBoundingClientRect()` answers in, then grown by
 * `margin` on every side and CLAMPED to the document.
 *
 * Two invariants, and the clamp exists for the first: the rectangle never starts in negative space
 * and never runs past the page, because coordinates no content is at are a picture with a blank
 * band in it that looks like a component with whitespace. And the margin may only ever make the
 * frame BIGGER — `Math.max` against the box's own size — so a document smaller than its own
 * content can never crop the component this run is of.
 *
 * `seen` is non-null and its box has area by the time this is reached: `photographFault` refuses
 * both above, and BEFORE the shutter, because a zero-area clip is `X_SCRAPE_CAPTURE_CLIP_EMPTY`
 * from the port — a worse report of the same fault than "rendered nothing". The `?? 0` pairs are
 * the parser's floor and not a second opinion.
 */
export function clipFor(seen: IslandReadiness | null, margin: number): CaptureClip {
  const x = (seen?.box.x ?? 0) + (seen?.scroll.x ?? 0);
  const y = (seen?.box.y ?? 0) + (seen?.scroll.y ?? 0);
  const width = seen?.box.width ?? 0;
  const height = seen?.box.height ?? 0;
  const left = Math.max(0, x - margin);
  const top = Math.max(0, y - margin);
  const right = Math.min(seen?.page.width ?? x + width, x + width + margin);
  const bottom = Math.min(seen?.page.height ?? y + height, y + height + margin);
  return {
    x: left,
    y: top,
    width: Math.max(width, right - left),
    height: Math.max(height, bottom - top),
  };
}

export interface IslandCaptureRun {
  readonly outDir: string;
  readonly driver: IslandBrowser;
  readonly settleMs: number;
  readonly timeoutMs: number;
  readonly extraHosts?: string | undefined;
  readonly cropMarginPx?: number | undefined;
}

const quietly = async (stop: () => Promise<void>): Promise<void> => {
  await stop().catch(() => undefined);
};

/**
 * One address, one full page load, one picture. Never a client-side switch between states: the
 * previous state's fixtures, its resolved resources and its mounted DOM would ride into the next
 * picture, which is the one way a screenshot tool can lie about its own subject.
 *
 * A session PER TARGET, and it costs a browser launch each: `page.console()` and `page.pageErrors()`
 * are bounded rings over the whole SESSION, so a shared one would file state A's console errors
 * under state B — and per-state attribution is the half of this artifact that gates.
 */
export async function captureIslandState(
  options: IslandCaptureRun,
  server: ShotServer,
  target: IslandShotTarget,
  floor: number,
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
    // BEFORE the navigation, so the first paint already has it: `prefers-color-scheme` is a live
    // media query, and the theme a component resolves on mount is the one it will keep.
    //
    // This is the INPUT and the harness's `data-theme` attribute is the OUTCOME, and both are set
    // deliberately. The attribute is right for a component that READS a theme it does not own; the
    // preference is the only thing that reaches one that RESOLVES its own. `examples/dummy`'s
    // settings island is the second kind — its state's `theme` prop is `'system'`, so on mount it
    // DELETES the attribute the harness set, both pictures fall through to `:root`, and the two
    // came back byte-identical with the same md5 (issue #338). Re-setting the attribute after
    // readiness is not the repair: it photographs a state the component would never reach.
    await page.colorScheme(target.theme);
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
    // The COMPONENT, not the viewport it happens to sit in — the crop this feature was designed
    // around, and which nothing passed until 2026-08-26 (issue #338).
    //
    // The clip ALONE. `fullPage: false` beside it is accepted — `assertCaptureFraming` refuses only
    // `=== true`, and `cdp-target.ts` sends `{ clip }` and nothing else either way — but it is a
    // field that says nothing: the two are exclusive, and spelling out the default of the one you
    // did not ask for reads as a choice.
    // `??` screens null and undefined and NOTHING else, so `cropMarginPx: NaN` reached `clipFor`,
    // where every comparison against it is false and the clamp silently answered `NaN` — a clip
    // the browser rejects, for a margin nobody typed. Same shape as `Skeleton`'s `lines: NaN`,
    // which rendered no placeholder at all: the screened value is what makes the default a bound.
    const clip = clipFor(
      seen,
      finiteCount('x shot --island', 'cropMarginPx', options.cropMarginPx ?? ISLAND_CROP_MARGIN_PX),
    );
    const bytes = await page.screenshot({ clip });
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
      overflow: seen?.overflow ?? { x: false, y: false },
    };
  } finally {
    const open = session;
    if (open !== undefined) await quietly(() => open.close());
  }
}
