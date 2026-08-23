// The app's own browser library, resolved from the app's own `node_modules` — never a dependency
// of this package. `@ultimat3/scraping` declares the launcher's shape structurally (`cdp-port.ts`)
// precisely so the framework can drive a browser without shipping one, and `x shot` is a CLI
// command holding to the same bargain: the app installs `puppeteer-core`, the CLI asks for it.

import { existsSync } from 'node:fs';
import { UltimateError } from '@ultimat3/core';
import type { CdpLauncherLike, ScrapeDriver } from '@ultimat3/scraping';
import { localBrowser } from '@ultimat3/scraping';

/**
 * The one library this works against. Playwright is not an alternative and is not a flag:
 * `packages/scraping/src/cdp-port.ts` records that its `connectOverCDP` cannot perform the
 * WebSocket upgrade under Bun (oven-sh/bun#9911), verified against puppeteer-core 25.8.0.
 */
export const BROWSER_PACKAGE = 'puppeteer-core';

/** Where a browser binary is named when the flag does not name one. Read in this order. */
export const BROWSER_PATH_VARS = ['PUPPETEER_EXECUTABLE_PATH', 'CHROME_PATH'] as const;

/**
 * A missing browser is an instruction, not a crash (axiom 4). The cause distinguishes the two
 * shapes — nothing resolved, or something resolved that is not a launcher — while the fix is the
 * same install either way, because both are answered by putting the real package in the app.
 */
export class ShotBrowserMissingError extends UltimateError {
  constructor(input: { root: string; detail: string }) {
    super({
      code: 'X_SHOT_BROWSER_MISSING',
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
 * Structural, because this is somebody else's module: a namespace object, a CJS `default`, or a
 * transpiled interop wrapper are all shapes `import()` legitimately hands back, and only one
 * question decides — is there a `launch` to call?
 */
const launcherIn = (module: unknown): CdpLauncherLike | undefined => {
  if (typeof module !== 'object' || module === null) return undefined;
  const candidate = module as { launch?: unknown; default?: unknown };
  if (typeof candidate.launch === 'function') return candidate as CdpLauncherLike;
  // `module.exports.default = module.exports` is a real CJS interop shape, so the self-reference is
  // refused rather than followed: one unbounded recursion here is a stack overflow instead of the
  // instruction this whole function exists to produce.
  if (candidate.default === undefined || candidate.default === candidate) return undefined;
  return launcherIn(candidate.default);
};

export interface AppBrowserOptions {
  readonly root: string;
  /** `--browser`, then `PUPPETEER_EXECUTABLE_PATH`, then `CHROME_PATH`. */
  readonly executablePath?: string | undefined;
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

/** The path a run will launch, or `undefined` for "let the library find its own". */
export const executablePathFrom = (
  flag: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined => {
  if (flag !== undefined && flag.length > 0) return flag;
  for (const name of BROWSER_PATH_VARS) {
    const value = env[name];
    if (value !== undefined && value.length > 0) return value;
  }
  return undefined;
};

/** True when a named executable is really there — a bad `--browser` is refused before a boot. */
export const browserBinaryExists = (path: string): boolean => existsSync(path);

/**
 * The app's `puppeteer-core`, as a `ScrapeDriver`. Resolved FROM THE APP ROOT rather than from
 * this module: `import('puppeteer-core')` here would find the CLI's own tree, which by design has
 * no such dependency, and would answer "missing" for an app that installed it correctly.
 */
export async function appBrowser(options: AppBrowserOptions): Promise<ScrapeDriver> {
  const resolve = options.resolve ?? ((specifier, from) => Bun.resolveSync(specifier, from));
  const load = options.load ?? ((path: string) => import(path) as Promise<unknown>);
  let entry: string;
  try {
    entry = resolve(BROWSER_PACKAGE, options.root);
  } catch {
    throw new ShotBrowserMissingError({ root: options.root, detail: 'does not resolve' });
  }
  const launcher = launcherIn(await load(entry));
  if (launcher === undefined) {
    throw new ShotBrowserMissingError({
      root: options.root,
      detail: `resolved to ${entry}, which exports no launch()`,
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
