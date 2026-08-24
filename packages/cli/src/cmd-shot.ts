// `x shot <route>` — a rendered route, on disk, for a reader who cannot open a browser. The
// picture is `shot.png`; the half that gates is `verdict.json`, because a picture cannot say that
// the island threw, that nothing hydrated, or that the document photographed is the sign-in page.
//
// Never a step of `x verify`: it needs a real browser, and a gate that goes red because a machine
// has no Chrome is a gate that fails for reasons unrelated to the change.

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { IDLE_HYDRATE_TIMEOUT_MS } from '@ultimat3/render';
import type { ScrapeDriver, ScrapeSession } from '@ultimat3/scraping';
import { DEFAULT_PAGE_TIMEOUT_MS, systemScrapeClock } from '@ultimat3/scraping';
import { requireAppRoot } from './app-root';
import { appBrowser } from './browser-launcher';
import { islandShot, islandShotResult, refuseRouteWithIsland } from './cmd-shot-island';
import type { CliCommand, CommandContext } from './command';
import { BadFlagError, MissingPositionalError } from './errors';
import { intFlagOr, PORT_RANGE } from './flag-number';
import type { CommandResult } from './output';
import type { ParsedArgs } from './parse';
import { flagBool, flagString } from './parse';
import { shotBrowserChoice } from './shot-browser';
import type { BootDevServer, ShotServer } from './shot-server';
import { allowHostsFrom, devServerFor, SHOT_DIR } from './shot-server';
import { SETTLE_POLL_MS, settleIslands } from './shot-settle';
import type { IslandCount, ShotArtifacts } from './shot-verdict';
import {
  buildVerdict,
  ISLAND_PROBE,
  parseIslandProbe,
  shotLines,
  shotSummary,
  verdictJson,
} from './shot-verdict';

/** Kernel-picked by default: :3000 is usually another project's dev server, not a free port. */
const DEFAULT_PORT = 0;

/**
 * How long the page is left alone after `load` before it is photographed: exactly the
 * `requestIdleCallback` deadline `@ultimat3/render`'s hydration runtime gives an `idle` island —
 * shoot sooner and the verdict reports `booted: 0` for a page that hydrates perfectly. READ from
 * that runtime rather than restated, because two copies of one number that must agree is the drift
 * axiom 2 refuses: the settle window is not "2 seconds", it is "the deadline the runtime uses".
 */
export const DEFAULT_SETTLE_MS = IDLE_HYDRATE_TIMEOUT_MS;

// Re-exported, not re-declared: `cmd-shot.test.ts` and the island path both name them, and a
// second declaration of a path or an allow-list rule is a second answer.
export type { BootDevServer, ShotServer };
export { allowHostsFrom, devServerFor, SHOT_DIR };

export const SHOT_IMAGE = 'shot.png';
export const SHOT_VERDICT = 'verdict.json';

/** A directory name a route can never escape: everything that is not a letter or digit is a dash. */
export function shotSlug(route: string): string {
  const slug = route.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug === '' ? 'root' : slug.toLowerCase();
}

const pathOf = (url: string): string => {
  try {
    return new URL(url).pathname;
  } catch {
    return '/';
  }
};

/**
 * A reserved name (RFC 2606) that resolves nowhere, so the origin check below can never be
 * satisfied by an accident of what the app's own host happens to be.
 */
const ROUTE_BASE = 'http://route.invalid';

/**
 * Where a browser would actually go. The refusal above reads `scheme:` and nothing else, and this
 * is the question it was standing in for: a path is a path only if resolving it lands back on the
 * origin it was resolved against.
 */
const resolvedOrigin = (path: string): string => {
  try {
    return new URL(path, ROUTE_BASE).origin;
  } catch {
    // A path `new URL` will not parse is one no browser will fetch either, and reporting it as the
    // origin it is not is the honest answer here.
    return '';
  }
};

const refuseRoute = (reason: string): never => {
  throw new BadFlagError({
    flag: 'route',
    command: 'shot',
    reason,
    // A placeholder, because there is nothing safe to substitute: unlike an absolute URL, an
    // origin-escaping route carries no path the caller can be assumed to have meant.
    fix: 'x shot /<path> --json',
  });
};

/**
 * A path on the app, never a URL. `x shot https://example.com` would photograph somebody else's
 * site through a headless browser inside your network, which is the SSRF shape `allowHosts` exists
 * to refuse — so it is refused here, at the argument, where the reader can still see why.
 *
 * `scheme:` was the ONLY spelling refused until 2026-08-22, and it is one of four: `//evil/x` is a
 * protocol-relative URL, `\evil\x` is the same thing to every URL parser (a backslash IS a slash
 * for a special scheme), and a TAB inside the path is deleted by the parser before the host is
 * read, so `/⇥/evil/x` becomes `//evil/x`. Each one reached `new URL(route, server.url)` and came
 * back pointed at another host. `allowHostsFrom` one layer down could not catch any of them: it
 * allows a HOSTNAME, and the hostname it is given is the one the page has already left — which is
 * how `x shot //localhost:9200/_cat/indices` photographed whatever else was on the dev box.
 */
export function readRoute(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') {
    throw new MissingPositionalError({ command: 'shot', positional: 'route', example: 'x shot /' });
  }
  const route = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(route)) {
    throw new BadFlagError({
      flag: 'route',
      command: 'shot',
      reason: `"${route}" is an absolute URL; x shot photographs a route of the app under test`,
      // The path out of the URL when it parses — the refusal's own fix line has to be runnable,
      // and `new URL('http://')` throws, so the fallback is the route every app has.
      fix: `x shot ${pathOf(route)} --json`,
    });
  }
  const path = route.startsWith('/') ? route : `/${route}`;
  // Its own refusal rather than folded into the origin check: `/a\b` stays on this origin and is
  // still not the route that was typed — the verdict would record `/a\b` beside a picture of
  // `/a/b`, which is the artifact lying about its own subject.
  if (path.includes('\\')) {
    return refuseRoute(`"${route}" contains a backslash, which a URL parser reads as "/"`);
  }
  const origin = resolvedOrigin(path);
  if (origin !== ROUTE_BASE) {
    return refuseRoute(
      `"${route}" is not a path on the app: a browser resolves it to ${origin === '' ? 'no URL at all' : origin}`,
    );
  }
  return path;
}

/**
 * The three integer flags, each read with its NAME as an argument. `intFlagOr` takes the name in a
 * `name:` field, which `flag-reads.ts` counts as a declaration rather than a read — so a command
 * whose only mention of `--settle` is inside that object declares a flag the rule reports as
 * having no reader. The example is derived from the default, so it is always a runnable line.
 */
const intFlag = (
  args: ParsedArgs,
  name: string,
  min: number,
  fallback: number,
  max?: number,
): number =>
  intFlagOr(
    args,
    {
      name,
      command: 'shot',
      min,
      ...(max === undefined ? {} : { max }),
      example: `x shot / --${name} ${fallback}`,
    },
    fallback,
  );

export interface ShotRun {
  readonly route: string;
  readonly outDir: string;
  readonly driver: ScrapeDriver;
  readonly boot: () => Promise<ShotServer>;
  readonly settleMs: number;
  readonly timeoutMs: number;
  readonly fullPage: boolean;
  /**
   * `--allow-hosts`, verbatim. The app's own host is added once the server is up and never here:
   * with `--port 0` the port — and therefore the origin — does not exist until after the boot.
   */
  readonly extraHosts?: string | undefined;
  readonly now?: (() => Date) | undefined;
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
  let session: ScrapeSession | undefined;
  try {
    const requestedUrl = new URL(options.route, server.url).toString();
    session = await options.driver.open({
      name: 'x shot',
      // The host the picture is of, plus whatever the caller named. Never `*`: a headless browser
      // inside your network is the widest SSRF surface an app can own, and a screenshot command is
      // not the place to open it by default. Every refusal lands in the verdict's `refused` count.
      rules: { allowHosts: allowHostsFrom(server.url, options.extraHosts) },
      clock: systemScrapeClock,
      timeoutMs: options.timeoutMs,
    });
    const page = session.page;
    await page.goto(requestedUrl, { timeout: options.timeoutMs });
    if (options.settleMs > 0) await Bun.sleep(options.settleMs);
    // The probe may legitimately answer nothing — a page that refuses evaluation, a driver with no
    // JS engine. `null` says so; a `0` would read as "the route renders no islands", which is a
    // different and much more alarming claim.
    const probe = (): Promise<IslandCount | null> =>
      page
        .evaluate(ISLAND_PROBE)
        .then(parseIslandProbe)
        .catch(() => null);
    // The same budget again, and deliberately no new flag: `settleMs` is the deadline at which the
    // runtime CALLS `import()`, so a mount gets exactly as long to settle as the runtime got to
    // start it — and `--settle 0`, which asks for no wait, still gets none.
    const islands = await settleIslands(probe, {
      windowMs: options.settleMs,
      pollMs: SETTLE_POLL_MS,
    });
    const bytes = await page.screenshot({ fullPage: options.fullPage });
    // Read AFTER the capture, so an error logged while the page settled is in the verdict that
    // ships with the picture it explains.
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

export const shotResult = (artifacts: ShotArtifacts): CommandResult => ({
  ok: artifacts.verdict.ok,
  command: 'shot',
  summary: shotSummary(artifacts.verdict),
  lines: shotLines(artifacts),
  data: {
    image: artifacts.image,
    verdictFile: artifacts.verdictFile,
    verdict: verdictJson(artifacts.verdict),
  },
});

export const shotCommand: CliCommand = {
  spec: {
    name: 'shot',
    summary: 'photograph one route, or one island in a state it declares, from a real browser',
    usage:
      'x shot <route> | --island <name> [--state <id>] [--port 0] [--out <dir>] [--settle 2000] [--json]',
    requiresApp: true,
    flags: [
      { name: 'port', type: 'string', summary: 'dev port (0 lets the kernel pick a free one)' },
      { name: 'out', type: 'string', summary: 'where shot.png and verdict.json are written' },
      { name: 'full', type: 'boolean', summary: 'whole page, not the fold', default: true },
      { name: 'settle', type: 'string', summary: 'ms to wait after load before capturing' },
      { name: 'timeout', type: 'string', summary: 'ms one navigation may take' },
      { name: 'browser', type: 'string', summary: 'browser executable puppeteer-core launches' },
      {
        name: 'cdp-url',
        type: 'string',
        summary: 'attach to a browser somebody else is running (a provider session, a sidecar)',
      },
      { name: 'allow-hosts', type: 'string', summary: 'extra hosts the page may request' },
      // A FLAG on `x shot` and never a second command: photographing a route and photographing a
      // component are one job with two subjects, and a parallel command would be the second path
      // axiom 1 refuses.
      {
        name: 'island',
        type: 'string',
        summary: 'photograph one island in every state it declares',
      },
      {
        name: 'state',
        type: 'string',
        summary: 'one declared state of that island, not all of them',
      },
    ],
  },
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('shot', ctx.cwd).dir;
    // Every value read before anything boots: a typo must not cost a browser and a dev server to
    // report, which is the rule `x routes` and `x mcp` already follow.
    const island = flagString(ctx.args, 'island');
    const positional = ctx.args.positionals[0];
    if (island !== undefined && island !== '' && positional !== undefined) {
      refuseRouteWithIsland(positional, island);
    }
    const route = island === undefined || island === '' ? readRoute(positional) : '';
    const port = intFlag(ctx.args, 'port', PORT_RANGE.min, DEFAULT_PORT, PORT_RANGE.max);
    const settleMs = intFlag(ctx.args, 'settle', 0, DEFAULT_SETTLE_MS);
    const timeoutMs = intFlag(ctx.args, 'timeout', 1, DEFAULT_PAGE_TIMEOUT_MS);
    // Which browser this run gets — start one here, or attach to one somebody else is running.
    // Decided by `shot-browser.ts` over plain inputs, and decided HERE, before a dev server or a
    // provider session exists to pay for a typo.
    const { cdpUrl, executablePath } = shotBrowserChoice({
      cdpFlag: flagString(ctx.args, 'cdp-url'),
      browserFlag: flagString(ctx.args, 'browser'),
      env: ctx.env,
    });
    const out = flagString(ctx.args, 'out');
    const boot = (): Promise<ShotServer> => devServerFor(root, ctx.env, port);
    if (island !== undefined && island !== '') {
      return islandShotResult(
        await islandShot({
          root,
          island,
          ...(flagString(ctx.args, 'state') === undefined
            ? {}
            : { state: flagString(ctx.args, 'state') }),
          ...(out === undefined ? {} : { out }),
          settleMs,
          timeoutMs,
          ...(executablePath === undefined ? {} : { executablePath }),
          ...(cdpUrl === undefined ? {} : { cdpUrl }),
          ...(flagString(ctx.args, 'allow-hosts') === undefined
            ? {}
            : { extraHosts: flagString(ctx.args, 'allow-hosts') }),
          boot,
        }),
      );
    }
    // Resolved before the boot for the same reason: an app with no browser installed must not pay
    // an embedded Postgres to be told to run `bun add -d puppeteer-core`.
    const driver = await appBrowser({
      root,
      ...(executablePath === undefined ? {} : { executablePath }),
      ...(cdpUrl === undefined ? {} : { cdpUrl }),
    });
    return shotResult(
      await runShot({
        route,
        outDir: out === undefined ? join(root, SHOT_DIR, shotSlug(route)) : resolve(root, out),
        driver,
        boot,
        settleMs,
        timeoutMs,
        fullPage: flagBool(ctx.args, 'full'),
        extraHosts: flagString(ctx.args, 'allow-hosts'),
      }),
    );
  },
};
