// The app's own browser library, resolved from the app's own `node_modules` — never a dependency
// of this package. `@ultimat3/scraping` declares the launcher's shape structurally (`cdp-port.ts`)
// precisely so the framework can drive a browser without shipping one, and `x shot` is a CLI
// command holding to the same bargain: the app installs `puppeteer-core`, the CLI asks for it.
//
// Two ways to get a browser, and the second is the one production uses. `localBrowser()` starts
// Chrome in this container; `remoteBrowser({ cdpUrl })` ATTACHES to one somebody else is running,
// which is what every stealth provider sells — a session created over their API answers with a
// `wss://` CDP endpoint and a real, unfingerprintable Chromium behind it. `driver-cdp.ts` has
// called attach its primary path since it shipped, and until now no CLI command could reach it.

import { existsSync } from 'node:fs';
import { UltimateError } from '@ultimat3/core';
import type { CdpLauncherLike, ScrapeDriver } from '@ultimat3/scraping';
import { localBrowser, remoteBrowser } from '@ultimat3/scraping';
import { CHROME_CANDIDATES } from './cdp-launch';

/**
 * The one library this works against. Playwright is not an alternative and is not a flag:
 * `packages/scraping/src/cdp-port.ts` records that its `connectOverCDP` cannot perform the
 * WebSocket upgrade under Bun (oven-sh/bun#9911), verified against puppeteer-core 25.8.0.
 */
export const BROWSER_PACKAGE = 'puppeteer-core';

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
 * A missing browser is an instruction, not a crash (axiom 4). The cause distinguishes the two
 * shapes — nothing resolved, or something resolved that is not a launcher — while the fix is the
 * same install either way, because both are answered by putting the real package in the app.
 */
export class ShotBrowserMissingError extends UltimateError {
  constructor(input: { root: string; detail: string }) {
    super({
      code: 'X_SHOT_BROWSER_MISSING',
      // The same install either way: attaching over CDP needs no Chrome on this box, but it still
      // needs a client that speaks the protocol, and `puppeteer-core` is that client.
      cause: `x shot drives a real browser and ${BROWSER_PACKAGE} ${input.detail} from ${input.root}`,
      // One literal, not `bun add -d ${BROWSER_PACKAGE}`: `fix-scan.ts` can only read a fix that IS
      // one literal, and a fix line the gate cannot read is a fix line nothing holds to the
      // contract. `browser-launcher.test.ts` pins it against the constant instead.
      fix: 'bun add -d puppeteer-core',
      meta: { root: input.root, package: BROWSER_PACKAGE },
    });
  }
}

/**
 * The OTHER half of "no browser": the library is installed and there is no Chrome for it to start.
 *
 * The same code as the class above because it is the same question to a reader — `x shot` has no
 * browser — and a code is a stable public name, not a taxonomy. The cause and the fix are what
 * differ, and they are the half that is acted on: `bun add -d puppeteer-core` cannot install
 * Chrome, and `export CHROME_PATH=…` cannot install a client that speaks CDP.
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
      // One literal, for `fix-scan.ts`'s reason — the same rule the class above states. It names an
      // export rather than an install because a path is the one repair that works whatever the
      // browser is and wherever the distribution put it; `--cdp-url` is the answer for a box that
      // will never have one, and it is a flag `x shot` already ships.
      fix: 'export CHROME_PATH=/usr/bin/google-chrome   # any Chrome or Chromium binary; a box that will never have one attaches instead: x shot / --cdp-url wss://cdp.example.com/session/abc',
      meta: { tried: [...CHROME_CANDIDATES], vars: [...BROWSER_PATH_VARS] },
    });
  }
}

/**
 * Structural, because this is somebody else's module: a namespace object, a CJS `default`, or a
 * transpiled interop wrapper are all shapes `import()` legitimately hands back, and only one
 * question decides — is the method this run needs there to call?
 *
 * WHICH method is the run's, not this function's. `cdp-port.ts` declares `launch` and `connect`
 * both optional precisely so an attach-only provider SDK satisfies the port, and asking for
 * `launch` when the run is going to `connect` would refuse exactly the library that works.
 */
const launcherIn = (module: unknown, method: 'launch' | 'connect'): CdpLauncherLike | undefined => {
  if (typeof module !== 'object' || module === null) return undefined;
  const candidate = module as Record<string, unknown>;
  if (typeof candidate[method] === 'function') return candidate as CdpLauncherLike;
  // `module.exports.default = module.exports` is a real CJS interop shape, so the self-reference is
  // refused rather than followed: one unbounded recursion here is a stack overflow instead of the
  // instruction this whole function exists to produce.
  const inner = candidate['default'];
  if (inner === undefined || inner === candidate) return undefined;
  return launcherIn(inner, method);
};

export interface AppBrowserOptions {
  readonly root: string;
  /** `--browser`, then `PUPPETEER_EXECUTABLE_PATH`, then `CHROME_PATH`. */
  readonly executablePath?: string | undefined;
  /**
   * A CDP endpoint to ATTACH to. When it is set nothing is launched here and `executablePath` is
   * not read: the browser is somebody else's, and closing it ends their session too — which
   * `remoteBrowser()` does deliberately, so a provider stops billing for a run that ended.
   */
  readonly cdpUrl?: string | undefined;
  /**
   * The page size this browser lays out at. A LAUNCH option and not a per-capture one, because
   * that is the only place the shipped port has for it: `CaptureRequest` is `fullPage` alone
   * (`packages/scraping/src/page.ts`), so the viewport IS the frame of every picture taken with
   * this driver — which is why `x shot --island` builds one browser per declared viewport.
   */
  readonly viewport?: { readonly width: number; readonly height: number } | undefined;
  /** Test seam: the resolver and the loader, so a test proves the refusal without an install. */
  readonly resolve?: (specifier: string, from: string) => string;
  readonly load?: (path: string) => Promise<unknown>;
}

/** True when a named executable is really there — a bad `--browser` is refused before a boot. */
export const browserBinaryExists = (path: string): boolean => existsSync(path);

/**
 * The path a run will launch, or `undefined` when this machine has no browser to launch.
 *
 * NOT "let the library find its own": `puppeteer-core` ships no browser and has no default, so a
 * launch with no `executablePath` throws ``An `executablePath` or `channel` must be specified``
 * from inside somebody else's library, one dev-server boot after the point where the answer was
 * knowable. So the last step is a PROBE — the same four paths `cdp-launch.ts` already tries for the
 * e2e driver, imported rather than restated, because two lists of Chrome locations that must agree
 * is the drift axiom 2 refuses.
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
 * The app's `puppeteer-core`, as a `ScrapeDriver`. Resolved FROM THE APP ROOT rather than from
 * this module: `import('puppeteer-core')` here would find the CLI's own tree, which by design has
 * no such dependency, and would answer "missing" for an app that installed it correctly.
 */
export async function appBrowser(options: AppBrowserOptions): Promise<ScrapeDriver> {
  const resolve = options.resolve ?? ((specifier, from) => Bun.resolveSync(specifier, from));
  const load = options.load ?? ((path: string) => import(path) as Promise<unknown>);
  const method = options.cdpUrl === undefined ? 'launch' : 'connect';
  let entry: string;
  try {
    entry = resolve(BROWSER_PACKAGE, options.root);
  } catch {
    throw new ShotBrowserMissingError({ root: options.root, detail: 'does not resolve' });
  }
  const launcher = launcherIn(await load(entry), method);
  if (launcher === undefined) {
    throw new ShotBrowserMissingError({
      root: options.root,
      detail: `resolved to ${entry}, which exports no ${method}()`,
    });
  }
  if (options.cdpUrl !== undefined) {
    return remoteBrowser({
      launcher,
      cdpUrl: options.cdpUrl,
      // The viewport reaches `connect()` the same way it reaches `launch()` — through the
      // pass-through slot — so `x shot --island`'s one-browser-per-viewport loop is unchanged by
      // which half of the port a run took.
      ...(options.viewport === undefined
        ? {}
        : { options: { defaultViewport: { ...options.viewport } } }),
    });
  }
  return localBrowser({
    launcher,
    headless: true,
    ...(options.executablePath === undefined ? {} : { executablePath: options.executablePath }),
    // `LocalBrowserOptions.options` is passed through to `launch()` untouched, which is the seam
    // that lets the CLI size a browser without `@ultimat3/scraping` naming a puppeteer type.
    ...(options.viewport === undefined
      ? {}
      : { options: { defaultViewport: { ...options.viewport } } }),
  });
}
