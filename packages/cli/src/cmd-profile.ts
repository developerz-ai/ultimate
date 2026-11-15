// `x profile <route>` — the app booted in THIS process (`startDev`, the web role, port 0), the
// route requested once to warm it, then `--runs` more under JavaScriptCore's sampling profiler
// (`bun:jsc`'s `profile`), and the hottest functions reported (`cmd-profile-frames.ts`). In-process
// because a sampling profiler sees only its own thread: a running `x dev` cannot be profiled.

import { profile } from 'bun:jsc';
import { renderFixShellArg } from '@ultimat3/core';
import { requireAppRoot } from './app-root';
import { hottestFrames, type ProfileSummary } from './cmd-profile-frames';
import { profileSpec } from './cmd-profile-spec';
import type { CliCommand, CommandContext } from './command';
import { startDev } from './dev-boot';
import { preflight } from './dev-lock';
import { BadFlagError, MissingPositionalError } from './errors';
import { intFlagOr } from './flag-number';
import { msg } from './messages';
import type { CommandResult, Finding, JsonValue } from './output';
import { resolveServices } from './runtime-bindings';
import { DEV_BINDING } from './web-binding';

/** Fine enough to see a render of a few milliseconds; the default 1 ms saw almost none. */
const SAMPLE_INTERVAL_MICROS = 100;

/** The booted app as the profile needs it: the pipeline's own dispatch, and the teardown. */
export interface ProfileTarget {
  fetch(request: Request): Promise<Response>;
  stop(): Promise<void>;
}

export type BootTarget = (root: string, ctx: CommandContext) => Promise<ProfileTarget>;

/** `startDev` behind `x dev`'s own claim on the state directory, so the two never share pgdata. */
const bootDev: BootTarget = async (root, ctx) => {
  const services = resolveServices(root, ctx.env);
  const { release } = await preflight({
    stateDir: services.stateDir,
    port: 0,
    hostname: DEV_BINDING.hostname,
    embeddedDb: services.db.mode === 'embedded',
  });
  const server = await startDev({ root, port: 0, env: ctx.env, roles: ['web'] }).catch(
    (error: unknown) => {
      release();
      throw error;
    },
  );
  const web = server.running.server;
  return {
    // In-process: no socket, so every sample is the render and none is the loopback round trip.
    fetch: (request) =>
      web === null ? Promise.resolve(new Response(null, { status: 503 })) : web.fetch(request),
    async stop() {
      try {
        await server.stop();
      } finally {
        release();
      }
    },
  };
};

function readRoute(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') {
    throw new MissingPositionalError({
      command: 'profile',
      positional: 'route',
      example: 'x profile / --json',
    });
  }
  const route = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(route)) {
    throw new BadFlagError({
      flag: 'route',
      command: 'profile',
      reason: `"${route}" is an absolute URL; x profile renders a route of this app, in this process`,
      fix: `x profile ${renderFixShellArg(URL.parse(route)?.pathname ?? '/', '/')} --json`,
    });
  }
  return route.startsWith('/') ? route : `/${route}`;
}

export interface RouteProfile {
  /** The warm-up's status: every profiled request is the same route, and it answered this. */
  readonly status: number;
  readonly summary: ProfileSummary;
}

/** One warm-up (first render compiles), then `runs` requests sampled. Bodies are read through. */
export async function profileRoute(input: {
  readonly fetch: (request: Request) => Promise<Response>;
  readonly path: string;
  readonly runs: number;
  readonly top: number;
  readonly root: string;
}): Promise<RouteProfile> {
  const request = (): Request => new Request(`http://localhost${input.path}`);
  const warm = await input.fetch(request());
  await warm.arrayBuffer();
  const sampled = await profile(async () => {
    for (let run = 0; run < input.runs; run += 1)
      await (await input.fetch(request())).arrayBuffer();
  }, SAMPLE_INTERVAL_MICROS);
  return {
    status: warm.status,
    summary: hottestFrames(sampled.stackTraces, input.root, input.top),
  };
}

const routeFailed = (route: string, status: number): Finding => ({
  code: 'X_PROFILE_ROUTE_FAILED',
  cause: `${route} answered ${status}, so the profile is of an error response rather than the route's render`,
  fix: `x routes --json   # the route table this app serves; then x profile <path> --json`,
});

export const profileCommandOver = (boot: BootTarget): CliCommand => ({
  spec: profileSpec,
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('profile', ctx.cwd).dir;
    const route = readRoute(ctx.args.positionals[0]);
    const runs = intFlagOr(
      ctx.args,
      { name: 'runs', command: 'profile', min: 1, max: 10_000, example: 'x profile / --runs 20' },
      20,
    );
    const top = intFlagOr(
      ctx.args,
      { name: 'top', command: 'profile', min: 1, max: 100, example: 'x profile / --top 10' },
      10,
    );
    const target = await boot(root, ctx);
    let result: RouteProfile;
    try {
      result = await profileRoute({ fetch: target.fetch, path: route, runs, top, root });
    } finally {
      await target.stop();
    }
    const { status, summary } = result;
    const findings = status >= 400 ? [routeFailed(route, status)] : [];
    const hottest: JsonValue = summary.hottest.map((frame) => ({ ...frame }));
    return {
      ok: findings.length === 0,
      command: 'profile',
      summary: msg('cli.profile.done', { route, runs, samples: summary.samples, status }),
      findings,
      data: {
        route,
        status,
        runs,
        samples: summary.samples,
        intervalMicros: summary.intervalMicros,
        hottest,
      },
      lines: summary.hottest.map((frame) =>
        msg('cli.profile.frame', {
          percent: frame.selfPercent,
          name: frame.name,
          at: frame.line === null ? frame.file : `${frame.file}:${frame.line}`,
        }),
      ),
    };
  },
});

export const profileCommand: CliCommand = profileCommandOver(bootDev);
