// `x shot <route>` — a rendered route, on disk, for a reader who cannot open a browser. The
// picture is `shot.png`; the half that gates is `verdict.json`, because a picture cannot say that
// the island threw, that nothing hydrated, or that the document photographed is the sign-in page.
//
// Never a step of `x verify`: it needs a real browser, and a gate that goes red because a machine
// has no Chrome is a gate that fails for reasons unrelated to the change.

import { join, resolve } from 'node:path';
import { renderFixShellArg } from '@ultimat3/core';
import { appLocaleSet } from '@ultimat3/i18n/app-catalogs';
import { IDLE_HYDRATE_TIMEOUT_MS } from '@ultimat3/render';
import { requireAppRoot } from './app-root';
import { appBrowser } from './browser-launcher';
import { DEFAULT_PAGE_TIMEOUT_MS } from './cdp-shot-clock';
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
import {
  MATRIX_DIR,
  matrixRoutes,
  planShotMatrix,
  refuseMatrixWithComponent,
  runShotMatrix,
} from './cmd-shot-matrix';
import { shotSpec } from './cmd-shot-spec';
import type { CliCommand, CommandContext } from './command';
import { BadFlagError } from './errors';
import { intFlagOr, PORT_RANGE } from './flag-number';
import type { CommandResult } from './output';
import type { ParsedArgs } from './parse';
import { flagBool, flagString } from './parse';
import { shotBrowserChoice } from './shot-browser';
import { readCookieFlag } from './shot-cookie';
import { localizedShotPath, readLocaleFlag } from './shot-locale';
import { readRoute, shotSlug } from './shot-route';
import { runShot } from './shot-run';
import type { BootDevServer, ShotServer } from './shot-server';
import { allowHostsFrom, devServerFor, SHOT_DIR } from './shot-server';
import { readThemeFlag } from './shot-theme';
import type { ShotArtifacts } from './shot-verdict';
import { shotLines, shotSummary, verdictJson } from './shot-verdict';
import { parseViewports, refuseViewportWithComponent, runShotViewports } from './shot-viewport';

/** Kernel-picked by default: :3000 is usually another project's dev server, not a free port. */
const DEFAULT_PORT = 0;

// Re-exported, not re-declared: a second declaration of a path, a host rule, the route rule or the
// capture is a second answer. The route rule is `shot-route.ts`'s, the capture `shot-run.ts`'s.
export { readRoute, shotSlug } from './shot-route';
export type { ShotRun } from './shot-run';
export { runShot, SHOT_IMAGE, SHOT_VERDICT } from './shot-run';
export type { BootDevServer, ShotServer };
export { allowHostsFrom, devServerFor, SHOT_DIR };

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

/**
 * Where the artifacts land. A relative `--out` is a path the caller typed from where they stand,
 * so it resolves against the cwd — `x build --out`'s rule. Against the app root it landed
 * somewhere else whenever `x shot` ran from `apps/web`.
 */
export const shotOutDir = (cwd: string, out: string | undefined, fallback: string): string =>
  out === undefined ? fallback : resolve(cwd, out);

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
    const cookies = readCookieFlag(flagString(ctx.args, 'cookie'));
    const viewports = parseViewports(flagString(ctx.args, 'viewport'));
    const app = await appLocaleSet(root);
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
    if (matrix && component) refuseMatrixWithComponent();
    // An island state declares its own size, so a size asked for beside one is a second answer.
    if (component && viewports !== undefined) refuseViewportWithComponent();
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
    // How long the page is left alone after `load` before it is photographed: exactly the
    // `requestIdleCallback` deadline `@ultimat3/render`'s hydration runtime gives an `idle` island —
    // shoot sooner and the verdict reports `booted: 0` for a page that hydrates perfectly. The
    // runtime's own constant, under its own name: the settle window is not "2 seconds", it is "the
    // deadline the runtime uses", and a second name for it is a second import path.
    const settleMs = intFlag(ctx.args, 'settle', 0, IDLE_HYDRATE_TIMEOUT_MS);
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
      // Absolute here, so the island sweep's own `resolve(root, out)` keeps the caller's path.
      ...(out === undefined ? {} : { out: shotOutDir(ctx.cwd, out, root) }),
      settleMs,
      timeoutMs,
      ...(executablePath === undefined ? {} : { executablePath }),
      ...(cdpUrl === undefined ? {} : { cdpUrl }),
      ...(flagString(ctx.args, 'allow-hosts') === undefined
        ? {}
        : { extraHosts: flagString(ctx.args, 'allow-hosts') }),
      ...(cookies.length === 0 ? {} : { cookies }),
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
      ...(cookies.length === 0 ? {} : { cookies }),
    };
    if (matrix) {
      // `--locale` and `--theme` narrow the matrix to one value of their axis.
      const cells = planShotMatrix({
        routes: route === '' ? await matrixRoutes(root) : [route],
        locales: locale === undefined ? app.locales : [locale],
        defaultLocale: app.defaultLocale,
        ...(theme === undefined ? {} : { themes: [theme] }),
        ...(viewports === undefined ? {} : { viewports }),
      });
      const outDir = shotOutDir(ctx.cwd, out, join(root, MATRIX_DIR));
      return runShotMatrix({ cells, outDir, boot, shoot: runShot, base });
    }
    const shown = locale ?? app.defaultLocale;
    const path = localizedShotPath(route, shown, app.defaultLocale);
    const single = {
      ...base,
      route: path,
      // Pinned whether or not `--locale` was given: the default locale, never the box's own.
      acceptLanguage: shown,
      ...(theme === undefined ? {} : { colorScheme: theme }),
    };
    const outDir = shotOutDir(ctx.cwd, out, join(root, SHOT_DIR, shotSlug(path)));
    if (viewports !== undefined) {
      return runShotViewports({ viewports, outDir, boot, shoot: runShot, base: single });
    }
    return shotResult(await runShot({ ...single, outDir, boot }));
  },
};
