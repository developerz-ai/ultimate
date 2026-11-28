// `x design research <url…>` — a reference site measured into framework vocabulary, so "make it look
// like that" becomes tokens, motion calls and effects entries instead of guesswork. The mechanism; the
// `design-research` skill is the procedure that drives it. Never a gate step: it needs a browser and
// the public web. Everything captured lands in `.x/design/` (ignored): third-party pixels are never
// committed.

// why: Bun exposes no path primitives; `--out` resolves against the caller's cwd.
import { join, resolve } from 'node:path';
import type { DialResolve } from '@ultimat3/core/outbound';
import type { ShotDriver } from './browser-launcher-port';
import { DEFAULT_PAGE_TIMEOUT_MS } from './cdp-shot-clock';
import { cdpShotDriver } from './cdp-shot-driver';
import type { DesignDriverFor } from './cmd-design-capture';
import { DESIGN_DIR, DESIGN_VIEWPORTS } from './cmd-design-paths';
import { type ResearchedReference, researchDesign, researchJson } from './cmd-design-run';
import { designSpec } from './cmd-design-spec';
import { loadThemeHost } from './cmd-design-theme';
import { designHostPolicy, readDesignAllowHosts } from './cmd-design-url';
import type { CliCommand, CommandContext } from './command';
import { BadFlagError, MissingPositionalError } from './errors';
import { intFlagOr } from './flag-number';
import { msg } from './messages';
import { DESIGN_SOURCES } from './messages-design';
import type { CommandResult } from './output';
import type { ParsedArgs } from './parse';
import { flagBool, flagString } from './parse';
import type { Env } from './runtime-bindings';
import { shotBrowserChoice } from './shot-browser';
import type { ShotViewport } from './shot-viewport';
import { parseViewports } from './shot-viewport';

/** Links per reference `--follow` may take: a catalogue page, not a crawl. */
export const FOLLOW_MAX = 20;

const EXAMPLE = 'x design research https://example.com/ --json';

const intFlag = (args: ParsedArgs, name: string, min: number, fallback: number, max?: number) =>
  intFlagOr(
    args,
    {
      name,
      command: 'design research',
      min,
      ...(max === undefined ? {} : { max }),
      example: `x design research https://example.com/ --${name} ${String(fallback)}`,
    },
    fallback,
  );

export interface DesignRunInput {
  readonly urls: readonly string[];
  readonly outDir: string;
  readonly env: Env;
  readonly follow?: number | undefined;
  readonly viewports?: readonly ShotViewport[] | undefined;
  readonly allowHosts?: readonly string[] | undefined;
  readonly timeoutMs?: number | undefined;
  /** Test seams, never flags: the browser, the resolver, and hosts admitted without one. */
  readonly driver?: ((viewport: ShotViewport) => Promise<ShotDriver>) | undefined;
  readonly resolve?: DialResolve | undefined;
  readonly trustedHosts?: readonly string[] | undefined;
}

/** The one body behind the command and `ui.research`. */
export async function runDesignResearch(
  input: DesignRunInput,
): Promise<readonly ResearchedReference[]> {
  const driverFor: DesignDriverFor = async (viewport, dialScreen) => {
    if (input.driver !== undefined) return input.driver(viewport);
    // The same choice `x shot` makes, from the environment: a local Chrome or an attach URL.
    const { cdpUrl, executablePath } = shotBrowserChoice({
      cdpFlag: undefined,
      browserFlag: undefined,
      env: input.env,
    });
    return cdpShotDriver({
      ...(cdpUrl === undefined ? {} : { cdpUrl }),
      ...(executablePath === undefined ? {} : { executablePath }),
      viewport,
      dialScreen,
    });
  };
  return researchDesign({
    urls: input.urls,
    follow: input.follow ?? 0,
    outDir: input.outDir,
    viewports: input.viewports ?? DESIGN_VIEWPORTS,
    allowHosts: input.allowHosts ?? [],
    timeoutMs: input.timeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS,
    policy: designHostPolicy({ resolve: input.resolve, trustedHosts: input.trustedHosts }),
    driverFor,
    themeHost: await loadThemeHost(),
    now: () => new Date(),
  });
}

export function designListResult(): CommandResult {
  return {
    ok: true,
    command: 'design',
    summary: msg('cli.design.list', { count: DESIGN_SOURCES.length }),
    lines: DESIGN_SOURCES.map((source) =>
      msg('cli.design.source', {
        name: source.name,
        url: source.url,
        posture: source.posture,
        why: source.why,
      }),
    ),
    data: {
      sources: DESIGN_SOURCES.map((source) => ({ ...source, hosts: [...source.hosts] })),
    },
  };
}

export function designResult(
  references: readonly ResearchedReference[],
  out: string,
): CommandResult {
  return {
    ok: true,
    command: 'design',
    summary: msg('cli.design.summary', { count: references.length, out }),
    lines: references.flatMap((reference) => [
      msg('cli.design.reference', { url: reference.url, dir: reference.dir }),
      msg('cli.design.facts', {
        colors: reference.colors,
        animations: reference.animations,
        refused: reference.refused,
      }),
      ...(reference.validated ? [] : [msg('cli.design.unvalidated')]),
    ]),
    data: researchJson(references),
  };
}

export const designCommand: CliCommand = {
  spec: designSpec,
  async run(ctx: CommandContext): Promise<CommandResult> {
    const urls = ctx.args.positionals;
    if (flagBool(ctx.args, 'list')) {
      if (urls.length > 0) {
        throw new BadFlagError({
          flag: 'list',
          command: 'design research',
          reason: 'lists the reference catalogues; it researches no URL',
          fix: 'x design research --list --json',
        });
      }
      return designListResult();
    }
    if (urls.length === 0) {
      throw new MissingPositionalError({
        command: 'design research',
        positional: 'url',
        example: EXAMPLE,
      });
    }
    // Every value read before a browser starts: a typo must not cost a launch to report.
    const follow = intFlag(ctx.args, 'follow', 0, 0, FOLLOW_MAX);
    const timeoutMs = intFlag(ctx.args, 'timeout', 1, DEFAULT_PAGE_TIMEOUT_MS);
    const viewports = parseViewports(flagString(ctx.args, 'viewport'));
    const allowHosts = readDesignAllowHosts(flagString(ctx.args, 'allow-hosts'));
    const flag = flagString(ctx.args, 'out');
    const outDir = flag === undefined ? join(ctx.cwd, DESIGN_DIR) : resolve(ctx.cwd, flag);
    const references = await runDesignResearch({
      urls,
      outDir,
      env: ctx.env,
      follow,
      viewports,
      allowHosts,
      timeoutMs,
    });
    return designResult(references, outDir);
  },
};
