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
import { appBrowser, browserBinaryExists, executablePathFrom } from './browser-launcher';
import { startDev } from './cmd-dev';
import type { CliCommand, CommandContext } from './command';
import { clearLock, isProcessAlive, lockPath, parseLock, preflight, writeLock } from './dev-lock';
import { DEV_BINDING } from './dev-roles';
import { resolveServices } from './dev-services';
import { BadFlagError, MissingPositionalError } from './errors';
import { intFlagOr, PORT_RANGE } from './flag-number';
import type { CommandResult } from './output';
import type { ParsedArgs } from './parse';
import { flagBool, flagString } from './parse';
import type { ShotArtifacts } from './shot-verdict';
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

export const SHOT_DIR = join('.x', 'shot');
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
 * A path on the app, never a URL. `x shot https://example.com` would photograph somebody else's
 * site through a headless browser inside your network, which is the SSRF shape `allowHosts` exists
 * to refuse — so it is refused here, at the argument, where the reader can still see why.
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
  return route.startsWith('/') ? route : `/${route}`;
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

export interface ShotServer {
  readonly url: string;
  /** Which server the picture is of. Reported, because the two have different failure modes. */
  readonly origin: 'booted' | 'reused';
  stop(): Promise<void>;
}

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
    const islands = await page
      .evaluate(ISLAND_PROBE)
      .then(parseIslandProbe)
      .catch(() => null);
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

/**
 * One rule, two branches: photograph the `x dev` this checkout already has, or boot a scratch one.
 * Reusing is not a convenience — embedded Postgres is a single-writer directory, so a second boot
 * on one checkout is `X_DEV_ALREADY_RUNNING` and the picture would never be taken at all.
 */
export async function devServerFor(
  root: string,
  env: Readonly<Record<string, string | undefined>>,
  port: number,
): Promise<ShotServer> {
  const services = resolveServices(root, env);
  const file = Bun.file(lockPath(services.stateDir));
  if (await file.exists()) {
    const lock = parseLock(await file.text());
    if (lock !== null && isProcessAlive(lock.pid)) {
      return { url: lock.url, origin: 'reused', stop: () => Promise.resolve() };
    }
  }
  await preflight({
    stateDir: services.stateDir,
    port,
    hostname: DEV_BINDING.hostname,
    embeddedDb: services.db.mode === 'embedded',
  });
  const dev = await startDev({ root, port, env });
  await writeLock(services.stateDir, {
    pid: process.pid,
    port,
    url: dev.url,
    startedAt: new Date().toISOString(),
  });
  return {
    url: dev.url,
    origin: 'booted',
    async stop() {
      clearLock(services.stateDir);
      await dev.stop();
    },
  };
}

/** `--allow-hosts a.com,b.com` on top of the app's own host. Empty means the app's host alone. */
export const allowHostsFrom = (url: string, extra: string | undefined): readonly string[] => {
  const named = (extra ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter((host) => host.length > 0);
  return [new URL(url).hostname, ...named];
};

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
    summary: 'photograph one route from a real browser, with a verdict a picture cannot carry',
    usage: 'x shot <route> [--port 0] [--out <dir>] [--no-full] [--settle 2000] [--json]',
    requiresApp: true,
    flags: [
      { name: 'port', type: 'string', summary: 'dev port (0 lets the kernel pick a free one)' },
      { name: 'out', type: 'string', summary: 'where shot.png and verdict.json are written' },
      { name: 'full', type: 'boolean', summary: 'whole page, not the fold', default: true },
      { name: 'settle', type: 'string', summary: 'ms to wait after load before capturing' },
      { name: 'timeout', type: 'string', summary: 'ms one navigation may take' },
      { name: 'browser', type: 'string', summary: 'browser executable puppeteer-core launches' },
      { name: 'allow-hosts', type: 'string', summary: 'extra hosts the page may request' },
    ],
  },
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('shot', ctx.cwd).dir;
    // Every value read before anything boots: a typo must not cost a browser and a dev server to
    // report, which is the rule `x routes` and `x mcp` already follow.
    const route = readRoute(ctx.args.positionals[0]);
    const port = intFlag(ctx.args, 'port', PORT_RANGE.min, DEFAULT_PORT, PORT_RANGE.max);
    const settleMs = intFlag(ctx.args, 'settle', 0, DEFAULT_SETTLE_MS);
    const timeoutMs = intFlag(ctx.args, 'timeout', 1, DEFAULT_PAGE_TIMEOUT_MS);
    const executablePath = executablePathFrom(flagString(ctx.args, 'browser'), ctx.env);
    if (executablePath !== undefined && !browserBinaryExists(executablePath)) {
      throw new BadFlagError({
        flag: 'browser',
        command: 'shot',
        reason: `no executable at "${executablePath}"`,
        fix: `x shot ${route} --browser /usr/bin/chromium`,
      });
    }
    const out = flagString(ctx.args, 'out');
    const boot = (): Promise<ShotServer> => devServerFor(root, ctx.env, port);
    // Resolved before the boot for the same reason: an app with no browser installed must not pay
    // an embedded Postgres to be told to run `bun add -d puppeteer-core`.
    const driver = await appBrowser({
      root,
      ...(executablePath === undefined ? {} : { executablePath }),
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
