// `x shot <route>` — a rendered route, on disk, for a reader who cannot open a browser. The
// picture is `shot.png`; the half that gates is `verdict.json`, because a picture cannot say that
// the island threw, that nothing hydrated, or that the document photographed is the sign-in page.
//
// Never a step of `x verify`: it needs a real browser, and a gate that goes red because a machine
// has no Chrome is a gate that fails for reasons unrelated to the change.

import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { renderFixShellArg } from '@ultimat3/core';
import { IDLE_HYDRATE_TIMEOUT_MS } from '@ultimat3/render';
import { requireAppRoot } from './app-root';
import { appBrowser } from './browser-launcher';
import type { ShotColorScheme, ShotDriver, ShotPage, ShotSession } from './browser-launcher-port';
import { DEFAULT_PAGE_TIMEOUT_MS, systemShotClock } from './cdp-shot-clock';
import {
  islandShot,
  islandShotResult,
  islandSweep,
  islandSweepResult,
  refuseRouteWithIsland,
  refuseSweepWithIsland,
  refuseSweepWithRoute,
  refuseSweepWithState,
} from './cmd-shot-island';
import { MATRIX_DIR, matrixRoutes, planShotMatrix, runShotMatrix } from './cmd-shot-matrix';
import { shotSpec } from './cmd-shot-spec';
import type { CliCommand, CommandContext } from './command';
import { BadFlagError, MissingPositionalError } from './errors';
import { intFlagOr, PORT_RANGE } from './flag-number';
import type { CommandResult } from './output';
import type { ParsedArgs } from './parse';
import { flagBool, flagString } from './parse';
import { shotBrowserChoice } from './shot-browser';
import {
  acceptLanguageHeaders,
  loadShotLocales,
  localizedShotPath,
  readLocaleFlag,
} from './shot-locale';
import type { BootDevServer, ShotServer } from './shot-server';
import { allowHostsFrom, devServerFor, SHOT_DIR } from './shot-server';
import { SETTLE_POLL_MS, settleIslands } from './shot-settle';
import { readThemeFlag, themeChoiceExpression } from './shot-theme';
import type { IslandCount, ShotArtifacts } from './shot-verdict';
import {
  buildVerdict,
  documentStatus,
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
  let session: ShotSession | undefined;
  try {
    const requestedUrl = new URL(options.route, server.url).toString();
    session = await options.driver.open({
      name: 'x shot',
      // The host the picture is of, plus whatever the caller named. Never `*`: a headless browser
      // inside your network is the widest SSRF surface an app can own, and a screenshot command is
      // not the place to open it by default. Every refusal lands in the verdict's `refused` count.
      rules: { allowHosts: allowHostsFrom(server.url, options.extraHosts) },
      clock: systemShotClock,
      timeoutMs: options.timeoutMs,
      ...(options.viewport === undefined ? {} : { viewport: options.viewport }),
      ...(options.acceptLanguage === undefined
        ? {}
        : { headers: acceptLanguageHeaders(options.acceptLanguage) }),
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
    const settle = (): Promise<IslandCount | null> =>
      settleIslands(probe, { windowMs: options.settleMs, pollMs: SETTLE_POLL_MS });
    let islands = await settle();
    if (options.act !== undefined) {
      await options.act(page, async () => {
        islands = await settle();
        return islands;
      });
    }
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
  spec: shotSpec,
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('shot', ctx.cwd).dir;
    // Every value read before anything boots: a typo must not cost a browser and a dev server to
    // report, which is the rule `x routes` and `x mcp` already follow.
    const island = flagString(ctx.args, 'island');
    const state = flagString(ctx.args, 'state');
    const theme = readThemeFlag(flagString(ctx.args, 'theme'));
    const positional = ctx.args.positionals[0];
    const sweep = flagBool(ctx.args, 'all-islands');
    const matrix = flagBool(ctx.args, 'matrix');
    const app = await loadShotLocales(root);
    const locale = readLocaleFlag(flagString(ctx.args, 'locale'), app);
    // Every ambiguous pair refused BY NAME, before a value is read: a reader who typed two
    // subjects has a belief about which one runs, and half of them would be wrong.
    if (sweep && island !== undefined && island !== '') refuseSweepWithIsland(island);
    if (sweep && positional !== undefined) refuseSweepWithRoute(positional);
    // A state id is one manifest's vocabulary, so it cannot mean anything across every island.
    if (sweep && state !== undefined && state !== '') refuseSweepWithState(state);
    if (island !== undefined && island !== '' && positional !== undefined) {
      refuseRouteWithIsland(positional, island);
    }
    const component = sweep || (island !== undefined && island !== '');
    // The matrix photographs ROUTES; a component beside it is two subjects.
    if (matrix && component) {
      throw new BadFlagError({
        flag: 'matrix',
        command: 'shot',
        reason: 'photographs every site route; --island and --all-islands photograph components',
        fix: 'x shot --matrix --json',
      });
    }
    // An island is photographed in BOTH themes by the harness, which owns its `data-theme` and
    // carries no boot script — so a theme asked for beside one is a request nothing could honour.
    if (component && locale !== undefined) {
      throw new BadFlagError({
        flag: 'locale',
        command: 'shot',
        reason: 'photographs a route; an island is photographed in the locale its states declare',
        fix: `x shot / --locale ${renderFixShellArg(locale, '<locale>')} --json`,
      });
    }
    if (component && theme !== undefined) {
      throw new BadFlagError({
        flag: 'theme',
        command: 'shot',
        reason: 'photographs a route; an island is photographed in both themes',
        fix: 'x shot / --theme light --json',
      });
    }
    // `--matrix` alone is every site route; a route beside it narrows the matrix to that one.
    const route = component || (matrix && positional === undefined) ? '' : readRoute(positional);
    const port = intFlag(ctx.args, 'port', PORT_RANGE.min, DEFAULT_PORT, PORT_RANGE.max);
    const settleMs = intFlag(ctx.args, 'settle', 0, DEFAULT_SETTLE_MS);
    const timeoutMs = intFlag(ctx.args, 'timeout', 1, DEFAULT_PAGE_TIMEOUT_MS);
    // Read only when given: its absence means "any 2xx", which no single default number can say.
    const expectStatus =
      flagString(ctx.args, 'expect-status') === undefined
        ? undefined
        : intFlag(ctx.args, 'expect-status', 100, 200, 599);
    // Which browser this run gets — start one here, or attach to one somebody else is running.
    // Decided by `shot-browser.ts` over plain inputs, and decided HERE, before a dev server or a
    // provider session exists to pay for a typo. It also PROBES for an installed Chrome and refuses
    // when there is none, so a missing browser costs no embedded Postgres boot.
    const { cdpUrl, executablePath } = shotBrowserChoice({
      cdpFlag: flagString(ctx.args, 'cdp-url'),
      browserFlag: flagString(ctx.args, 'browser'),
      env: ctx.env,
    });
    const out = flagString(ctx.args, 'out');
    const boot = (): Promise<ShotServer> => devServerFor(root, ctx.env, port);
    const shared = {
      root,
      ...(out === undefined ? {} : { out }),
      settleMs,
      timeoutMs,
      ...(executablePath === undefined ? {} : { executablePath }),
      ...(cdpUrl === undefined ? {} : { cdpUrl }),
      ...(flagString(ctx.args, 'allow-hosts') === undefined
        ? {}
        : { extraHosts: flagString(ctx.args, 'allow-hosts') }),
      boot,
    };
    if (sweep) return islandSweepResult(await islandSweep(shared));
    if (island !== undefined && island !== '') {
      return islandShotResult(
        await islandShot({ ...shared, island, ...(state === undefined ? {} : { state }) }),
      );
    }
    // Built before the boot, for the same reason.
    const driver = await appBrowser({
      ...(executablePath === undefined ? {} : { executablePath }),
      ...(cdpUrl === undefined ? {} : { cdpUrl }),
    });
    const base = {
      driver,
      settleMs,
      timeoutMs,
      fullPage: flagBool(ctx.args, 'full'),
      extraHosts: flagString(ctx.args, 'allow-hosts'),
      ...(expectStatus === undefined ? {} : { expectStatus }),
    };
    if (matrix) {
      // `--locale` and `--theme` narrow the matrix to one value of their axis.
      const cells = planShotMatrix({
        routes: route === '' ? await matrixRoutes(root) : [route],
        locales: locale === undefined ? app.locales : [locale],
        defaultLocale: app.defaultLocale,
        ...(theme === undefined ? {} : { themes: [theme] }),
      });
      const outDir = out === undefined ? join(root, MATRIX_DIR) : resolve(root, out);
      return runShotMatrix({ cells, outDir, boot, shoot: runShot, base });
    }
    const shown = locale ?? app.defaultLocale;
    const path = localizedShotPath(route, shown, app.defaultLocale);
    return shotResult(
      await runShot({
        ...base,
        route: path,
        outDir: out === undefined ? join(root, SHOT_DIR, shotSlug(path)) : resolve(root, out),
        boot,
        // Pinned whether or not `--locale` was given: the default locale, never the box's own.
        acceptLanguage: shown,
        ...(theme === undefined ? {} : { colorScheme: theme }),
      }),
    );
  },
};
