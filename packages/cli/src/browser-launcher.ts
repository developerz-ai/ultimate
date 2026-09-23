// Which browser `x shot` drives, and the raw-CDP driver over it (`cdp-shot-driver.ts`). No browser
// library, in the app or here: Chrome is launched on its debugging pipe by `@ultimat3/testing`'s
// launcher — the one `x verify`'s e2e step already runs on — or ATTACHED to over `--cdp-url`,
// which is what every stealth provider sells. Until 22.0.0 this resolved the APP's `puppeteer-core`,
// so `x shot` needed an install the framework could not make, and two launchers drifted.

import { existsSync } from 'node:fs';
import { UltimateError } from '@ultimat3/core';
import { CHROME_CANDIDATES } from '@ultimat3/testing';
import type { ShotDriver } from './browser-launcher-port';
import { cdpShotDriver } from './cdp-shot-driver';

/** Where a browser binary is named when the flag does not name one. Read in this order. */
export const BROWSER_PATH_VARS = ['PUPPETEER_EXECUTABLE_PATH', 'CHROME_PATH'] as const;

/**
 * Where a CDP endpoint is named when `--cdp-url` does not name one. `SCRAPE_CDP_URL` and not a
 * name of this command's own: `@ultimat3/scraping`'s `remoteRequired` refusal already tells its
 * reader `remoteBrowser({ cdpUrl: env.SCRAPE_CDP_URL })`, and a second spelling would make the
 * package's own instruction wrong for the CLI that follows it.
 */
export const BROWSER_CDP_URL_VAR = 'SCRAPE_CDP_URL';

/** The schemes a CDP endpoint can arrive as: a provider's `wss://`, a sidecar's `http://`. */
const CDP_SCHEMES = ['ws:', 'wss:', 'http:', 'https:'] as const;

/**
 * `x shot` has no browser: none was named and none of the probed paths is on disk.
 *
 * Raised BEFORE the dev server, which is the whole point of it: the launch that used to report this
 * happens inside `driver.open()`, one embedded Postgres past the point where the answer was already
 * decidable from the environment and the filesystem.
 */
export class ShotChromeMissingError extends UltimateError {
  constructor() {
    super({
      code: 'X_SHOT_BROWSER_MISSING',
      cause: `x shot launches a browser here and none was named or found — no ${BROWSER_PATH_VARS.join(' or ')} is set, and none of ${CHROME_CANDIDATES.join(', ')} is on disk`,
      // One literal, so `fix-scan.ts` can read it. A path is the one repair that works whatever the
      // browser is and wherever the distribution put it; `--cdp-url` is the answer for a box that
      // will never have one, and it is a flag `x shot` already ships.
      fix: 'export CHROME_PATH=/usr/bin/google-chrome   # any Chrome or Chromium binary; a box that will never have one attaches instead: x shot / --cdp-url wss://cdp.example.com/session/abc',
      meta: { tried: [...CHROME_CANDIDATES], vars: [...BROWSER_PATH_VARS] },
    });
  }
}

export interface AppBrowserOptions {
  /** `--browser`, then `PUPPETEER_EXECUTABLE_PATH`, then `CHROME_PATH`, then the probe. */
  readonly executablePath?: string | undefined;
  /**
   * A CDP endpoint to ATTACH to. When it is set nothing is launched here and `executablePath` is
   * not read: the browser is somebody else's, and closing it ends their session too — deliberately,
   * so a provider stops billing for a run that ended.
   */
  readonly cdpUrl?: string | undefined;
  /**
   * The page size this browser lays out at — the frame of every viewport picture, which is why
   * `x shot --island` builds one browser per declared viewport.
   */
  readonly viewport?: { readonly width: number; readonly height: number } | undefined;
}

/** True when a named executable is really there — a bad `--browser` is refused before a boot. */
export const browserBinaryExists = (path: string): boolean => existsSync(path);

/**
 * The path a run will launch, or `undefined` when this machine has no browser to launch.
 *
 * The last step is a PROBE — the four paths `cdp-launch.ts` tries for the e2e driver, imported
 * rather than restated, because two lists of Chrome locations that must agree is the drift axiom 2
 * refuses — so a box with no browser is refused before a dev-server boot, not one launch later.
 *
 * A value NAMED in the flag or the environment is answered without touching the filesystem, even
 * when nothing is there: an operator who typed a path has a belief about which binary runs, and
 * silently substituting a probed one would photograph a page in a browser they did not choose.
 * `shotBrowserChoice` reports that path as absent instead.
 *
 * `exists` is the injectable seam, so the probe is asserted the same way on a machine with Chrome
 * and on one without.
 */
export const executablePathFrom = (
  flag: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
  exists: (path: string) => boolean = browserBinaryExists,
): string | undefined => {
  if (flag !== undefined && flag.length > 0) return flag;
  for (const name of BROWSER_PATH_VARS) {
    const value = env[name];
    if (value !== undefined && value.length > 0) return value;
  }
  for (const candidate of CHROME_CANDIDATES) {
    if (exists(candidate)) return candidate;
  }
  return undefined;
};

/** The endpoint a run will attach to, or `undefined` for "launch one here". */
export const cdpUrlFrom = (
  flag: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined => {
  if (flag !== undefined && flag.length > 0) return flag;
  const value = env[BROWSER_CDP_URL_VAR];
  return value !== undefined && value.length > 0 ? value : undefined;
};

/**
 * The scheme, checked here rather than at `connect()`. A `--cdp-url` naming an https page or a
 * bare host is a typo, and a typo must not cost an embedded Postgres and a provider session to
 * report — the same rule `--browser` follows against the filesystem one line above.
 */
export const cdpUrlProblem = (url: string): string | undefined => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'is not a URL';
  }
  return CDP_SCHEMES.includes(parsed.protocol as (typeof CDP_SCHEMES)[number])
    ? undefined
    : `has scheme "${parsed.protocol}", and a CDP endpoint is ${CDP_SCHEMES.join(', ')}`;
};

/**
 * The driver a run photographs with. Refused HERE when there is nothing to launch and nothing to
 * attach to, so a missing browser costs no dev-server boot.
 */
export async function appBrowser(options: AppBrowserOptions): Promise<ShotDriver> {
  if (options.cdpUrl === undefined && options.executablePath === undefined) {
    throw new ShotChromeMissingError();
  }
  return cdpShotDriver({
    ...(options.cdpUrl === undefined ? {} : { cdpUrl: options.cdpUrl }),
    ...(options.executablePath === undefined ? {} : { executablePath: options.executablePath }),
    ...(options.viewport === undefined ? {} : { viewport: options.viewport }),
  });
}
