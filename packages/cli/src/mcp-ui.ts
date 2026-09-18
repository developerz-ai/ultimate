// The dev MCP server's two eyes: `ui.shot` (a route) and `ui.island` (a component's states), as
// the `DevCapabilities` half `packages/mcp` declares and cannot satisfy — a browser is the CLI's
// to launch. Both are `x shot` under another name: the same server lookup (a running `x dev` is
// reused through its lock, otherwise a scratch one boots), the same driver, the same verdict.
// Nothing here is a new capability; it is the existing one made reachable from inside the loop
// an agent already works in, so "does it look right" stops needing a hand-written script.

// why: Bun exposes no path-join primitive, and the picture's directory is a path an agent opens.
import { join } from 'node:path';
import { UltimateError } from '@ultimat3/core';
import type { UiIslandInput, UiIslandResult, UiShotInput, UiShotResult } from '@ultimat3/mcp';
import { describeRoutes } from '@ultimat3/render';
import type { ScrapeDriver } from '@ultimat3/scraping';
import { DEFAULT_PAGE_TIMEOUT_MS } from '@ultimat3/scraping';
import { appBrowser } from './browser-launcher';
import { DEFAULT_SETTLE_MS, runShot, SHOT_DIR, shotSlug } from './cmd-shot';
import { islandShot } from './cmd-shot-island';
import type { Env } from './dev-services';
import { islandVerdictJson } from './island-verdict';
import { retryMemo } from './retry-memo';
import { shotBrowserChoice } from './shot-browser';
import { devServerFor, type ShotServer } from './shot-server';
import { verdictJson } from './shot-verdict';

/** Kernel-picked, as `x shot` picks it: a scratch server never fights another project for :3000. */
const SCRATCH_PORT = 0;

/**
 * The route a picture is of has to be a route this app declares WITH a JS budget. The gate
 * refuses an unmeasured route (`X_BUDGET_UNMEASURED`), and a picture of a route nobody has
 * finished declaring is a picture of a draft — an agent judging it would judge the wrong thing.
 * Matched on the declared pattern, so `/links/abc123` finds `/links/:slug`.
 */
export interface DeclaredRoute {
  readonly path: string;
  readonly file: string;
  readonly budgetJs: string | null;
}

export function assertBudgetedRoute(route: string, declared: readonly DeclaredRoute[]): void {
  const path = route.split('?')[0] ?? route;
  const hit = declared.find((entry) => matches(entry.path, path));
  if (hit === undefined) {
    throw new UltimateError({
      code: 'X_UI_SHOT_ROUTE_UNKNOWN',
      cause: `no route in this app answers ${route}`,
      fix: 'x routes --json   # then ui.shot with one of its `path` values',
    });
  }
  if (hit.budgetJs === null) {
    throw new UltimateError({
      code: 'X_UI_SHOT_ROUTE_UNBUDGETED',
      cause: `${hit.file} declares no budget.js, so x verify would refuse it as X_BUDGET_UNMEASURED — a picture of it would be a picture of a draft`,
      fix: `declare budget: { js: '<n>kb' } in ${hit.file}, then: x build --target static --json && x verify --only budgets --json`,
    });
  }
}

/** `/links/:slug` matches `/links/abc123`; one segment per `:param`, no globbing. */
export function matches(pattern: string, path: string): boolean {
  const want = pattern.split('/');
  const have = path.split('/');
  if (want.length !== have.length) return false;
  return want.every((segment, index) => segment.startsWith(':') || segment === have[index]);
}

export interface UiHostInput {
  readonly root: string;
  readonly env: Env;
  /** Injected by a test: the server a picture is of, in place of `devServerFor`. */
  readonly boot?: (() => Promise<ShotServer>) | undefined;
  /** Injected by a test: the browser, in place of `appBrowser` (which needs Chrome). */
  readonly driver?: ((viewport: UiShotInput['viewport']) => Promise<ScrapeDriver>) | undefined;
  /** Injected by a test: the route table, in place of the registry. */
  readonly routes?: (() => readonly DeclaredRoute[]) | undefined;
}

export interface UiCapabilities {
  shotRoute(shot: UiShotInput): Promise<UiShotResult>;
  shotIsland(island: UiIslandInput): Promise<UiIslandResult>;
  /** Stops the scratch server, if one was booted. Never boots one in order to stop it. */
  close(): Promise<void>;
}

export function uiCapabilities(input: UiHostInput): UiCapabilities {
  const { root, env } = input;
  // ONCE per process, never per call. `x shot` the command boots a server, photographs, and
  // stops it — one process, one lifecycle. The dev MCP server is one process serving many calls,
  // and a lifecycle drains exactly once: the second `ui.shot` in a session answered
  // `X_LIFECYCLE_DRAINED`, the third `X_READINESS_CHECK_DUPLICATE`. So the scratch server (or the
  // running `x dev` the lock names) is memoised for the host's life, `runShot` is handed a handle
  // whose `stop` is a no-op, and `close()` is what stops it. A boot that rejected is retried on
  // the next call, and has nothing to stop.
  const scratch = retryMemo(() => (input.boot ?? (() => devServerFor(root, env, SCRATCH_PORT)))());
  const boot = async (): Promise<ShotServer> => {
    const server = await scratch.get();
    return { url: server.url, origin: server.origin, stop: () => Promise.resolve() };
  };
  // The same choice `x shot` makes from the environment: `PUPPETEER_EXECUTABLE_PATH`, a
  // provider's CDP URL, or the launcher's own discovery.
  const browser = () => shotBrowserChoice({ cdpFlag: undefined, browserFlag: undefined, env });
  const routes = input.routes ?? describeRoutes;
  let closed = false;

  return {
    async close() {
      // Idempotent, as `lazyServices().close()` is: the host closes once, a test may close twice,
      // and a server stopped twice is a second drain on a lifecycle that has none left.
      if (closed) return;
      closed = true;
      await (await scratch.started()?.catch(() => undefined))?.stop();
    },

    async shotRoute(shot) {
      assertBudgetedRoute(shot.route, routes());
      const { cdpUrl, executablePath } = browser();
      const driver =
        input.driver === undefined
          ? await appBrowser({
              root,
              viewport: shot.viewport,
              ...(executablePath === undefined ? {} : { executablePath }),
              ...(cdpUrl === undefined ? {} : { cdpUrl }),
            })
          : await input.driver(shot.viewport);
      // One directory per (route, viewport, scheme), so two pictures of one route at two widths
      // never overwrite each other and an agent can hold both.
      const outDir = join(
        root,
        SHOT_DIR,
        shotSlug(shot.route),
        `${shot.viewport.width}x${shot.viewport.height}-${shot.colorScheme}`,
      );
      const artifacts = await runShot({
        route: shot.route,
        outDir,
        driver,
        boot,
        settleMs: DEFAULT_SETTLE_MS,
        timeoutMs: DEFAULT_PAGE_TIMEOUT_MS,
        fullPage: shot.fullPage,
        colorScheme: shot.colorScheme,
      });
      return {
        ok: artifacts.verdict.ok,
        image: artifacts.image,
        verdictFile: artifacts.verdictFile,
        verdict: verdictJson(artifacts.verdict),
      };
    },

    async shotIsland(island) {
      const { cdpUrl, executablePath } = browser();
      const artifacts = await islandShot({
        root,
        island: island.island,
        ...(island.state === undefined ? {} : { state: island.state }),
        settleMs: DEFAULT_SETTLE_MS,
        timeoutMs: DEFAULT_PAGE_TIMEOUT_MS,
        ...(executablePath === undefined ? {} : { executablePath }),
        ...(cdpUrl === undefined ? {} : { cdpUrl }),
        boot,
      });
      return {
        ok: artifacts.verdict.ok,
        dir: artifacts.dir,
        verdictFile: artifacts.verdictFile,
        verdict: islandVerdictJson(artifacts.verdict),
      };
    },
  };
}
