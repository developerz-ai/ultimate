// One reference URL photographed and measured: one browser per viewport, both colour schemes, the
// recorder installed before the document, the scroll-and-hover pass after load, a clipped PNG per
// (viewport, scheme).
//
// Every request the page makes is screened browser-wide (`dialScreen`), and a navigation the screen
// or the floor stopped is `X_DESIGN_URL_REFUSED`, never a picture of an error page.

// why: Bun has no recursive directory create.
import { mkdirSync } from 'node:fs';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { isUltimateError, renderThrowable } from '@ultimat3/core';
import { systemClock } from '@ultimat3/core/adapter';
import { CdpCallFailedError, CdpTimeoutError } from '@ultimat3/scraping/cdp';
import type { CaptureClip, NetworkEntry, ShotDriver, ShotPage } from './browser-launcher-port';
import type { DialRefusal, DialScreen } from './cdp-shot-driver-screen';
import {
  DesignAbortedError,
  DesignReferenceUnreachableError,
  DesignUrlRefusedError,
} from './cmd-design-errors';
import { DESIGN_SCHEMES, type DesignScheme, referenceShotName } from './cmd-design-paths';
import type { DesignHostPolicy } from './cmd-design-url';
import { browserDialScreen } from './cmd-design-url';
import { type Extraction, extractDesign, mergeExtractions } from './design-extract';
import { DESIGN_PREPARE } from './design-extract-script';
import { hash8 } from './shot-diff';
import { documentStatus } from './shot-verdict';
import { type ShotViewport, VIEWPORT_MAX } from './shot-viewport';

/** How a capture gets its browser: `cdpShotDriver` with the screen in production, a fake in tests. */
export type DesignDriverFor = (
  viewport: ShotViewport,
  dialScreen: Omit<DialScreen, 'owns'>,
) => Promise<ShotDriver>;

export interface CaptureInput {
  readonly url: string;
  readonly dir: string;
  readonly viewports: readonly ShotViewport[];
  readonly timeoutMs: number;
  readonly policy: DesignHostPolicy;
  readonly driverFor: DesignDriverFor;
  readonly signal?: AbortSignal | undefined;
}

export interface Capture {
  /** Where the page landed, as `pageRef`: `location.href` is page-settable text. */
  readonly finalUrl: string;
  readonly byScheme: Readonly<Record<DesignScheme, Extraction>>;
  readonly shots: readonly string[];
  /** Hostnames of every request refused as inward — the floor's and the resolver's — never a URL. */
  readonly refusedHosts: readonly string[];
  /** Hostnames refused because they did not resolve: unreachable, not private. */
  readonly unresolvedHosts: readonly string[];
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};

/** The navigation's failure as one of this command's two codes. */
function navigationError(url: string, error: unknown, timeoutMs: number): Error {
  if (isUltimateError(error) && error.code === 'X_SHOT_HOST_REFUSED') {
    return new DesignUrlRefusedError({
      url,
      reason: 'names a loopback, private or link-local address',
    });
  }
  const detail = renderThrowable(error);
  // The one reason a navigation is BlockedByClient: the floor or the resolver failed it.
  if (detail.includes('ERR_BLOCKED_BY_CLIENT')) {
    return new DesignUrlRefusedError({
      url,
      reason:
        'redirected to, or loaded its document from, a loopback, private or link-local address',
    });
  }
  if (error instanceof CdpTimeoutError) {
    return new DesignReferenceUnreachableError({
      url,
      reason: `did not finish loading within ${String(timeoutMs)}ms`,
      timeoutMs,
    });
  }
  if (error instanceof CdpCallFailedError) {
    return new DesignReferenceUnreachableError({ url, reason: detail, timeoutMs });
  }
  return error instanceof Error
    ? error
    : new DesignReferenceUnreachableError({ url, reason: detail, timeoutMs });
}

async function visit(page: ShotPage, input: CaptureInput, scheme: DesignScheme): Promise<void> {
  await page.colorScheme(scheme);
  try {
    await page.goto(input.url, { timeout: input.timeoutMs });
  } catch (error) {
    throw navigationError(input.url, error, input.timeoutMs);
  }
  const status = documentStatus(page.network(), page.url());
  if (status !== null && status >= 400) {
    throw new DesignReferenceUnreachableError({
      url: input.url,
      reason: `answered HTTP ${String(status)}`,
      timeoutMs: input.timeoutMs,
    });
  }
}

const refusedBy = (network: readonly NetworkEntry[]): string[] =>
  network.filter((entry) => entry.refused !== undefined).map((entry) => hostOf(entry.url));

/**
 * The capture's clip: the viewport's width (a reference photographed at 390 is 390 wide, whatever
 * overflows sideways) and the document's height up to `VIEWPORT_MAX` — Chrome's texture limit, past
 * which a capture is tiles nobody painted, and a page that reports a million pixels of height is
 * a memory bomb, not a reference. The size is page-reported, so it is clamped, never trusted.
 */
async function captureClip(page: ShotPage, viewport: ShotViewport): Promise<CaptureClip> {
  const reported = await page
    .evaluate('document.documentElement.scrollHeight')
    .catch(() => viewport.height);
  const height = typeof reported === 'number' && Number.isFinite(reported) ? reported : 0;
  return {
    x: 0,
    y: 0,
    width: viewport.width,
    height: Math.min(VIEWPORT_MAX, Math.max(viewport.height, Math.ceil(height))),
  };
}

/** Every page-supplied URL is reported as its origin and a hash: its path is the page's text. */
export const pageRef = (url: string): string => {
  try {
    return `${new URL(url).origin}#${hash8(url)}`;
  } catch {
    return `#${hash8(url)}`;
  }
};

export async function captureReference(input: CaptureInput): Promise<Capture> {
  const { signal } = input;
  const refused: string[] = [];
  const unresolved: string[] = [];
  const dialScreen = {
    screen: browserDialScreen(input.policy),
    refused: (url: string, reason: DialRefusal) =>
      (reason === 'private' ? refused : unresolved).push(hostOf(url)),
  };
  const aborted = (): DesignAbortedError => new DesignAbortedError({ url: input.url });
  // A function, not a read: the flag flips while the awaits below are pending.
  const isAborted = (): boolean => signal?.aborted === true;
  const perScheme = new Map<DesignScheme, Extraction[]>(
    DESIGN_SCHEMES.map((scheme) => [scheme, []]),
  );
  const of = (scheme: DesignScheme): Extraction[] => perScheme.get(scheme) ?? [];
  const shots: string[] = [];
  let finalUrl = input.url;
  mkdirSync(input.dir, { recursive: true });
  for (const viewport of input.viewports) {
    // Checked before every launch: a cancelled call must not keep starting browsers.
    if (isAborted()) throw aborted();
    const driver = await input.driverFor(viewport, dialScreen);
    const session = await driver.open({
      name: 'x design research',
      rules: { allowHosts: input.policy.allowHosts },
      clock: systemClock,
      timeoutMs: input.timeoutMs,
      viewport,
    });
    // An abort mid-capture ends the browser at once; the pending CDP call then fails and is
    // reported as the abort it is, never as an unreachable page.
    const stop = (): void => void session.close();
    signal?.addEventListener('abort', stop, { once: true });
    try {
      await session.page.prepare(DESIGN_PREPARE);
      for (const scheme of DESIGN_SCHEMES) {
        await visit(session.page, input, scheme);
        finalUrl = session.page.url();
        of(scheme).push(await extractDesign(session.page));
        const clip = await captureClip(session.page, viewport);
        const bytes = await session.page.screenshot({ clip });
        if (isAborted()) throw aborted();
        const file = join(input.dir, referenceShotName(viewport.width, scheme));
        await Bun.write(file, bytes);
        shots.push(file);
      }
      refused.push(...refusedBy(session.page.network()));
    } catch (error) {
      throw isAborted() ? aborted() : error;
    } finally {
      signal?.removeEventListener('abort', stop);
      await session.close();
    }
  }
  const hosts = (list: readonly string[]) =>
    [...new Set(list.filter((host) => host !== ''))].sort();
  return {
    finalUrl: pageRef(finalUrl),
    byScheme: { light: mergeExtractions(of('light')), dark: mergeExtractions(of('dark')) },
    shots,
    refusedHosts: hosts(refused),
    unresolvedHosts: hosts(unresolved),
  };
}
