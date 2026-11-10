// One route photographed: boot (or find) the server, drive the page, settle the islands, take the
// picture and write `shot.png` beside the `verdict.json` that gates. The driver and the boot are
// arguments, so `bun test` proves the whole capture with no Chrome.

import { mkdirSync } from 'node:fs'; // why: Bun has no recursive directory create.
import { join } from 'node:path'; // why: Bun exposes no path-join primitive.
import { systemClock } from '@ultimat3/core/adapter';
import type { ShotColorScheme, ShotDriver, ShotPage, ShotSession } from './browser-launcher-port';
import { type ShotCookiePair, shotCookies } from './shot-cookie';
import { readShotGpu } from './shot-gpu';
import { acceptLanguageHeaders } from './shot-locale';
import type { ShotServer } from './shot-server';
import { allowHostsFrom } from './shot-server';
import { SETTLE_POLL_MS, settleIslands } from './shot-settle';
import { themeChoiceExpression } from './shot-theme';
import type { IslandCount, ShotArtifacts } from './shot-verdict';
import {
  buildVerdict,
  documentStatus,
  ISLAND_PROBE,
  parseIslandProbe,
  verdictJson,
} from './shot-verdict';

export const SHOT_IMAGE = 'shot.png';
export const SHOT_VERDICT = 'verdict.json';

export interface ShotRun {
  readonly route: string;
  readonly outDir: string;
  readonly driver: ShotDriver;
  readonly boot: () => Promise<ShotServer>;
  readonly settleMs: number;
  readonly timeoutMs: number;
  readonly fullPage: boolean;
  /**
   * `--allow-hosts`, verbatim. The app's own host is added once the server is up and never here:
   * with `--port 0` the port — and therefore the origin — does not exist until after the boot.
   */
  readonly extraHosts?: string | undefined;
  /**
   * The theme the picture is of. Two things happen BEFORE navigation, because the boot script runs
   * inline and nothing after `goto` can reach it: `prefers-color-scheme` is emulated so the boot's
   * "system" branch answers the same on every box, AND the scheme is stored as the visitor's
   * choice under `THEME_STORAGE_KEY` (`shot-theme.ts`), because an app with `theme.defaultMode`
   * set answers that before the OS and only a stored choice beats it (issue #489). Absent means
   * neither: the box's own preference and the app's own default — what `x shot` has always done,
   * and the point of `defaultMode` — and `ui.shot` names one explicitly for exactly that reason.
   */
  readonly colorScheme?: ShotColorScheme | undefined;
  /** CSS pixels the page is laid out in; absent is the driver's default. */
  readonly viewport?: { readonly width: number; readonly height: number } | undefined;
  /**
   * Sent as `Accept-Language` on every request. The command always sets it — `--locale`, or the
   * app's default locale — so a picture never depends on the language of the machine's Chrome.
   */
  readonly acceptLanguage?: string | undefined;
  /**
   * `--cookie`: set before the first navigation, each for the server's own URL once it is up —
   * so a consent banner (or any cookie-held choice) is decided in the picture.
   */
  readonly cookies?: readonly ShotCookiePair[] | undefined;
  readonly now?: (() => Date) | undefined;
  /**
   * `--expect-status`: the document status this shot is ok with — `404` to photograph the not-found
   * page on purpose. Absent means any 2xx, and anything else fails the verdict with the status.
   */
  readonly expectStatus?: number | undefined;
  /**
   * Something to do with the page AFTER the islands settled and BEFORE the picture — `ui.inspect`
   * reads the DOM here, on the one navigation the picture already paid for. `settle` re-runs the
   * island poll (an action that mounts something changes the count the verdict reports); the
   * caller who never calls it gets the count from the first settle.
   */
  readonly act?:
    | ((page: ShotPage, settle: () => Promise<IslandCount | null>) => Promise<void>)
    | undefined;
  /**
   * The clock the settle window runs on — the same seam `SettleOptions.sleep` and
   * `InteractDeps.sleep` take, and the reason they had none on this path: `settleMs` was a
   * `Bun.sleep` here, so a caller that injected a sleep everywhere else still paid the real
   * 2000 ms window in wall time once per `runShot`, and a test doing it twice raced its own
   * per-test timeout on a slower box. Absent is `Bun.sleep`: production waits for real.
   */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
}

/** Nothing here may replace the failure that caused it, so a teardown throw is swallowed. */
const quietly = async (stop: () => Promise<void>): Promise<void> => {
  await stop().catch(() => undefined);
};

/**
 * Boot (or find) the server, photograph one route, write both artifacts. The driver and the boot
 * are ARGUMENTS: `bun test` drives this with `fakeBrowser()` and a stub server, so the whole
 * command is proved on a machine with no Chrome — which this command is explicitly excluded from
 * the gate for needing.
 */
export async function runShot(options: ShotRun): Promise<ShotArtifacts> {
  const server = await options.boot();
  const sleep = options.sleep ?? ((ms: number): Promise<void> => Bun.sleep(ms));
  let session: ShotSession | undefined;
  try {
    const requestedUrl = new URL(options.route, server.url).toString();
    session = await options.driver.open({
      name: 'x shot',
      // The host the picture is of, plus whatever the caller named. Never `*`: a headless browser
      // inside your network is the widest SSRF surface an app can own, and a screenshot command is
      // not the place to open it by default. Every refusal lands in the verdict's `refused` count.
      rules: { allowHosts: allowHostsFrom(server.url, options.extraHosts) },
      clock: systemClock,
      timeoutMs: options.timeoutMs,
      ...(options.viewport === undefined ? {} : { viewport: options.viewport }),
      ...(options.acceptLanguage === undefined
        ? {}
        : { headers: acceptLanguageHeaders(options.acceptLanguage) }),
      ...(options.cookies === undefined || options.cookies.length === 0
        ? {}
        : { cookies: shotCookies(options.cookies, new URL(server.url).toString()) }),
    });
    const page = session.page;
    if (options.colorScheme !== undefined) {
      await page.colorScheme(options.colorScheme);
      const choice = themeChoiceExpression(options.colorScheme);
      if (choice !== undefined) await page.prepare(choice);
    }
    await page.goto(requestedUrl, { timeout: options.timeoutMs });
    // Read NOW as well as at capture: the network ring is bounded, and a page that fires a few
    // hundred requests while it settles evicts the document entry the verdict needs.
    const landedStatus = documentStatus(page.network(), page.url());
    if (options.settleMs > 0) await sleep(options.settleMs);
    // A probe may answer nothing (a page refusing evaluation, a driver with no JS engine): `null`
    // says so, where a `0` would claim "no islands". `gpu` is read the same way, after the picture.
    const probe = (): Promise<IslandCount | null> =>
      page
        .evaluate(ISLAND_PROBE)
        .then(parseIslandProbe)
        .catch(() => null);
    // The same budget again, no new flag: `settleMs` is when the runtime CALLS `import()`, so a
    // mount gets as long to settle as the runtime got to start it; `--settle 0` still gets none.
    const settle = (): Promise<IslandCount | null> =>
      settleIslands(probe, { windowMs: options.settleMs, pollMs: SETTLE_POLL_MS, sleep });
    let islands = await settle();
    if (options.act !== undefined) {
      await options.act(page, async () => {
        islands = await settle();
        return islands;
      });
    }
    const bytes = await page.screenshot({ fullPage: options.fullPage });
    // Read AFTER the capture: an error logged while the page settled ships with its picture.
    const gpu = await readShotGpu(page);
    const verdict = buildVerdict({
      route: options.route,
      requestedUrl,
      finalUrl: page.url(),
      server: server.origin,
      capturedAt: (options.now ?? (() => new Date()))().toISOString(),
      screenshot: SHOT_IMAGE,
      bytes,
      console: page.console(),
      pageErrors: page.pageErrors(),
      pageErrorsDropped: page.pageErrorsDropped(),
      network: page.network(),
      networkDropped: page.networkDropped(),
      islands,
      gpu,
      landedStatus,
      ...(options.expectStatus === undefined ? {} : { expectStatus: options.expectStatus }),
    });
    mkdirSync(options.outDir, { recursive: true });
    const image = join(options.outDir, SHOT_IMAGE);
    const verdictFile = join(options.outDir, SHOT_VERDICT);
    await Bun.write(image, bytes);
    await Bun.write(verdictFile, `${JSON.stringify(verdictJson(verdict), null, 2)}\n`);
    return { verdict, image, verdictFile };
  } finally {
    // Bound to a const: narrowing a `let` does not survive into the closure below, and the session
    // has to be closed from inside one so a teardown throw cannot replace the real failure.
    const open = session;
    if (open !== undefined) await quietly(() => open.close());
    await quietly(() => server.stop());
  }
}
