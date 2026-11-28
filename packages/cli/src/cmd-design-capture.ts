// One reference URL photographed and measured: one browser per viewport, both colour schemes, the
// recorder installed before the document, the scroll-and-hover pass after load, a full-page PNG per
// (viewport, scheme). Every request the page makes is screened browser-wide (`dialScreen`), and a
// navigation the screen or the floor stopped is `X_DESIGN_URL_REFUSED`, never a picture of an
// error page.

// why: Bun has no recursive directory create.
import { mkdirSync } from 'node:fs';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { isUltimateError, renderThrowable } from '@ultimat3/core';
import { systemClock } from '@ultimat3/core/adapter';
import { CdpCallFailedError, CdpTimeoutError } from '@ultimat3/scraping/cdp';
import type { NetworkEntry, ShotDriver, ShotPage } from './browser-launcher-port';
import type { DialScreen } from './cdp-shot-driver-screen';
import { DesignReferenceUnreachableError, DesignUrlRefusedError } from './cmd-design-errors';
import { DESIGN_SCHEMES, type DesignScheme, referenceShotName } from './cmd-design-paths';
import type { DesignHostPolicy } from './cmd-design-url';
import { browserDialScreen } from './cmd-design-url';
import { type Extraction, extractDesign, mergeExtractions } from './design-extract';
import { DESIGN_PREPARE } from './design-extract-script';
import { documentStatus } from './shot-verdict';
import type { ShotViewport } from './shot-viewport';

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
}

export interface Capture {
  readonly finalUrl: string;
  readonly byScheme: Readonly<Record<DesignScheme, Extraction>>;
  readonly shots: readonly string[];
  /** Hostnames of every request refused — the floor's and the resolver's — never the full URL. */
  readonly refusedHosts: readonly string[];
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

export async function captureReference(input: CaptureInput): Promise<Capture> {
  const refused: string[] = [];
  const dialScreen = {
    screen: browserDialScreen(input.policy),
    refused: (url: string) => refused.push(hostOf(url)),
  };
  const perScheme: Record<DesignScheme, Extraction[]> = { light: [], dark: [] };
  const shots: string[] = [];
  let finalUrl = input.url;
  mkdirSync(input.dir, { recursive: true });
  for (const viewport of input.viewports) {
    const driver = await input.driverFor(viewport, dialScreen);
    const session = await driver.open({
      name: 'x design research',
      rules: { allowHosts: input.policy.allowHosts },
      clock: systemClock,
      timeoutMs: input.timeoutMs,
      viewport,
    });
    try {
      await session.page.prepare(DESIGN_PREPARE);
      for (const scheme of DESIGN_SCHEMES) {
        await visit(session.page, input, scheme);
        finalUrl = session.page.url();
        perScheme[scheme].push(await extractDesign(session.page));
        const file = join(input.dir, referenceShotName(viewport.width, scheme));
        await Bun.write(file, await session.page.screenshot({ fullPage: true }));
        shots.push(file);
      }
      refused.push(...refusedBy(session.page.network()));
    } finally {
      await session.close();
    }
  }
  return {
    finalUrl,
    byScheme: { light: mergeExtractions(perScheme.light), dark: mergeExtractions(perScheme.dark) },
    shots,
    refusedHosts: [...new Set(refused.filter((host) => host !== ''))].sort(),
  };
}
