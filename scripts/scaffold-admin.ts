#!/usr/bin/env bun
// Prove that a new app's `/admin` serves a generated resource: boot the scaffolded app the way its
// developer does (`x dev`), create a row through the admin's own form as the `admin` role, find it
// in the list, edit it, delete it, and be refused both as the `member` role. Every earlier step of `scaffold-smoke`
// typechecks and gates the files `x g resource` wrote; none of them opened a socket, so an admin
// that mounted nothing — or mounted for everybody — was green.
//
// Runs AFTER `scaffold-first-run.ts` and the `bun run setup` that applies its migration: the
// resource is the one `x g resource` generated there, and its table has to exist.
//
// THE REFUSED ACTOR IS `member`, NOT "ANONYMOUS". A scaffolded app issues no session yet: its
// `apps/web/app/auth/dev-actor.ts` answers every development request as a role named by a cookie,
// so there is no anonymous request to make against `x dev` — and `member` is the role its own
// `shared/roles.ts` withholds `admin:read` from.
//
//   bun run scripts/scaffold-admin.ts <app dir> [--json]

import { DEV_BINDING, quoteArg } from '@ultimat3/cli';
import { renderThrowable } from '@ultimat3/core';
import { bindFreePorts, isPortClash } from '../packages/testing/src/free-port-bind';
import type { AdminStep, AdminWalk, Fetcher } from './lib/admin-walk';
import { adminFindings, walkAdmin } from './lib/admin-walk';
import { parseScriptArgs } from './lib/args';
import type { ScriptResult } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { ScriptError } from './lib/script-error';
import { strangerEnvAt } from './lib/stranger-env';
import { appBin, generatorName } from './scaffold-first-run';

const SCRIPT = 'scaffold-admin';
const DEV_ACTOR = 'apps/web/app/auth/dev-actor.ts';
const MANIFEST = 'x.manifest.json';
/** How long `x dev` may take to answer its first request. Measured ~2 s; this is the kill-switch. */
const BOOT_BUDGET_MS = 60_000;
/**
 * The dev server's whole life: the boot budget plus a walk measured in seconds. `stop()` ends it on
 * every path this script reaches; the deadline is for the one it does not — a walk that hangs.
 */
const SERVER_DEADLINE_MS = 300_000;

/** The table `x g resource` writes for the name `scaffold-first-run.ts` gives it. */
export function adminResource(manifest: unknown): string | undefined {
  const entities: unknown = (manifest as { readonly entities?: unknown } | null)?.entities;
  if (!Array.isArray(entities)) return undefined;
  const stem = generatorName('resource').replace(/-/g, '_');
  return entities
    .map((entity: unknown) => (entity as { readonly name?: unknown } | null)?.name)
    .find((name): name is string => typeof name === 'string' && name.startsWith(stem));
}

export const devRoleCookie = (devActorSource: string): string | undefined =>
  /DEV_ROLE_COOKIE\s*=\s*'([^']+)'/.exec(devActorSource)?.[1];

/** The server `x dev` is, as far as this check needs one: is it still there, and make it stop. */
export interface DevServer {
  readonly exited: () => boolean;
  /** Stops it and answers what it printed — the only evidence when it never came up. */
  stop(): Promise<string>;
}

/**
 * How one boot gets its port: `bind` IS the boot, and a port another process held first is the
 * boot's `X_PORT_IN_USE`, asked again on a fresh pair — never a port probed and released.
 */
export type PortBinder = <T>(
  bind: (port: number) => Promise<T>,
  /** Whether the last failure `bind` threw was a lost race — read off what the boot PRINTED. */
  clashed?: () => boolean,
) => Promise<T>;

/**
 * The real binder: a free PAIR — `x dev` binds the web role on `port` and its sync node on
 * `port + 1`, both on `localhost`, so a lone free port whose neighbour was taken booted, listened
 * and stopped again. Each loopback address is asked (CI run 41764752262), and a pair another
 * process took before `x dev` bound it is booted again (`bindFreePorts`).
 */
export const freeDevPorts: PortBinder = (bind, clashed) =>
  bindFreePorts(([port = 0]) => bind(port), {
    pair: true,
    ...(clashed === undefined ? {} : { clashed }),
  });

/** One fixed port, for a test whose `x dev` is a fake that binds nothing. */
export const fixedPort =
  (port: number): PortBinder =>
  (bind) =>
    bind(port);

/** A boot that died because its port was taken: the binder's signal to boot again. */
export const portTaken = (port: number, output: string, fix: string): ScriptError =>
  new ScriptError({
    code: 'X_SCAFFOLD_FIRST_RUN_FAILED',
    cause: `x dev --port ${String(port)} met a port another process held: ${output.trim().split('\n').slice(-6).join(' | ').slice(0, 600)}`,
    fix,
  });

/** Everything the check touches outside its own arguments, so the whole of it runs under test. */
export interface AdminCheckIo {
  readonly boot: (dir: string, port: number) => DevServer;
  readonly fetcher: Fetcher;
  readonly ports: PortBinder;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

/**
 * The app directory as the three fixes here spell it — the ONE rule, always wrapped in `quoteArg`
 * at the site so the fix-shell-arg guard reads the word as screened. Quoted, not refused: `dir` is
 * whatever path the caller handed this script, and `./my-app`, the common case, has to stay
 * pasteable. A leading `-` is a flag however it is quoted, so it is the placeholder.
 */
export const appDirWord = (dir: string): string => (dir.startsWith('-') ? '<app dir>' : dir);

const refused = (summary: string, cause: string, fix: string, at: string): ScriptResult => ({
  ok: false,
  script: SCRIPT,
  summary,
  findings: [{ code: 'X_SCAFFOLD_FIRST_RUN_FAILED', cause, fix, at }],
});

/** The last lines a server printed, on one line: what a boot that never answered has to say. */
const tail = (output: string): string =>
  output.trim().split('\n').slice(-6).join(' | ').slice(0, 600);

/** One boot on `port`: boot `x dev`, wait for it, walk the admin, stop it — always. */
async function bootAndWalk(
  dir: string,
  io: AdminCheckIo,
  port: number,
  resource: string,
  roleCookie: string,
) {
  // The NAME `x dev` binds, never a literal address: Bun binds `localhost` as `[::1]` alone on a
  // host whose hosts file maps it to both loopbacks (GitHub's Ubuntu runner), and a dial at
  // `127.0.0.1` there is refused for the whole budget while `x dev` reports itself ready.
  const base = `http://${DEV_BINDING.hostname}:${String(port)}`;
  const walk: AdminWalk = { base, resource, roleCookie };
  const fix = `cd ${quoteArg(appDirWord(dir))} && bun run dev --port ${quoteArg(String(port))}`;
  const started = io.now();
  const server = io.boot(dir, port);
  let steps: readonly AdminStep[] = [];
  let bootMs = 0;
  let up = false;
  let output = '';
  /** Why the last dial failed: a boot log that ends "ready" is no evidence of WHY nothing answered. */
  let lastDial = 'no dial was made';
  try {
    while (!up && !server.exited() && io.now() - started < BOOT_BUDGET_MS) {
      up = await io.fetcher(`${base}/admin`, { redirect: 'manual' }).then(
        () => true,
        (error: unknown) => {
          lastDial = renderThrowable(error);
          return false;
        },
      );
      if (!up) await io.sleep(100);
    }
    bootMs = Math.round(io.now() - started);
    if (up) steps = await walkAdmin(walk, io.fetcher);
  } finally {
    output = await server.stop();
  }
  return { port, walk, steps, bootMs, up, output, lastDial, fix, started };
}

/** Boot the app in `dir`, walk its admin, stop it — always — and answer the whole verdict. */
export async function checkAdmin(dir: string, io: AdminCheckIo): Promise<ScriptResult> {
  const manifest = Bun.file(`${dir}/${MANIFEST}`);
  const devActor = Bun.file(`${dir}/${DEV_ACTOR}`);
  const resource = (await manifest.exists()) ? adminResource(await manifest.json()) : undefined;
  const roleCookie = (await devActor.exists()) ? devRoleCookie(await devActor.text()) : undefined;
  if (resource === undefined || roleCookie === undefined) {
    return refused(
      `${dir} is not a scaffolded app with a generated resource`,
      resource === undefined
        ? `${dir}/${MANIFEST} names no entity \`x g resource ${generatorName('resource')}\` wrote, so there is no admin screen to ask for`
        : `${dir}/${DEV_ACTOR} declares no DEV_ROLE_COOKIE, so no request can say which role it is`,
      `bun run scripts/scaffold-first-run.ts ${quoteArg(appDirWord(dir))} && (cd ${quoteArg(appDirWord(dir))} && bun run setup)`,
      dir,
    );
  }
  // A missing `x` is not a refused admin: `bun install` never ran, and a spawn would say ENOENT.
  if (!(await Bun.file(appBin(dir)).exists())) {
    return refused(
      `no x binary at ${appBin(dir)}`,
      `${appBin(dir)} does not exist, so the scaffolded app cannot be booted`,
      `cd ${quoteArg(appDirWord(dir))} && bun run setup`,
      dir,
    );
  }

  // Read off the boot's WHOLE output: the refusal's cause keeps only its tail, and a clash
  // followed by a stack or a drain's log would read as no clash there.
  let clashed = false;
  const run = await io
    .ports(
      async (port) => {
        const booted = await bootAndWalk(dir, io, port, resource, roleCookie);
        clashed = !booted.up && isPortClash(booted.output);
        if (clashed) throw portTaken(port, booted.output, booted.fix);
        return booted;
      },
      () => clashed,
    )
    .catch((error: unknown) => {
      if (error instanceof ScriptError) return error;
      throw error;
    });
  if (run instanceof ScriptError) {
    return refused(`x dev did not answer in ${dir}`, run.cause, run.fix, dir);
  }
  const { port, walk, steps, bootMs, up, output, lastDial, fix, started } = run;
  if (!up) {
    return refused(
      `x dev did not answer in ${dir}`,
      `x dev --port ${String(port)} answered no request in ${String(bootMs)} ms — the last dial at ${walk.base}/admin: ${lastDial} — it printed: ${tail(output)}`,
      fix,
      dir,
    );
  }
  const findings = adminFindings(dir, walk, steps);
  const totalMs = Math.round(io.now() - started);
  return {
    ok: findings.length === 0,
    script: SCRIPT,
    summary:
      findings.length === 0
        ? `${dir}: /admin/${resource} lists a row its own form created, edits and deletes it, and refuses the member role (boot ${String(bootMs)} ms, ${String(totalMs)} ms in all)`
        : `${String(findings.length)} of ${String(steps.length)} admin step(s) failed in ${dir}`,
    findings,
    lines: steps.map((step) => `  ${step.ok ? '✓' : '✗'} ${step.name}`),
    data: { dir, resource, bootMs, totalMs, steps },
  };
}

/** The real thing: the app's own `x dev`, a free port pair it binds itself, the wall clock. */
const realIo: AdminCheckIo = {
  boot: (dir, port) => {
    const server = Bun.spawn([appBin(dir), 'dev', '--port', String(port), '--json'], {
      cwd: dir,
      // A whole env: `Bun.spawn` replaces, and the app is not this repo's code.
      env: strangerEnvAt(repoRoot()),
      timeout: SERVER_DEADLINE_MS,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const printed = Promise.all([
      new Response(server.stdout).text(),
      new Response(server.stderr).text(),
    ]);
    return {
      exited: () => server.exitCode !== null,
      stop: async () => {
        server.kill('SIGTERM');
        await server.exited;
        return (await printed).join('\n');
      },
    };
  },
  fetcher: fetch,
  ports: freeDevPorts,
  now: () => performance.now(),
  sleep: (ms) => Bun.sleep(ms),
};

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const dir = args.positionals[0];
  report(
    dir === undefined
      ? refused(
          'a scaffolded app directory is required',
          'no app directory given, so there is no scaffolded app to boot',
          'bun run scripts/scaffold-admin.ts /tmp/demoapp --json',
          'scripts/scaffold-admin.ts',
        )
      : await checkAdmin(dir, realIo),
    args.json,
  );
}
