#!/usr/bin/env bun
// Prove that a new app's `/admin` serves a generated resource: boot the scaffolded app the way its
// developer does (`x dev`), create a row through the admin's own form as the `admin` role, find it
// in the list, edit it, delete it, and be refused both as the `member` role. Every earlier step of `scaffold-smoke`
// typechecks and gates the files `x g resource` wrote; none of them opened a socket, so an admin
// that mounted nothing — or mounted for everybody — was green.
//
// Runs AFTER `scaffold-first-run.ts` and the `bin/setup` that applies its migration: the resource
// is the one `x g resource` generated there, and its table has to exist.
//
// THE REFUSED ACTOR IS `member`, NOT "ANONYMOUS". A scaffolded app issues no session yet: its
// `apps/web/app/auth/dev-actor.ts` answers every development request as a role named by a cookie,
// so there is no anonymous request to make against `x dev` — and `member` is the role its own
// `shared/roles.ts` withholds `admin:read` from.
//
//   bun run scripts/scaffold-admin.ts <app dir> [--json]

import { DEV_BINDING, quoteArg } from '@ultimat3/cli';
import { renderThrowable } from '@ultimat3/core';
import type { AdminStep, AdminWalk, Fetcher } from './lib/admin-walk';
import { adminFindings, walkAdmin } from './lib/admin-walk';
import { parseScriptArgs } from './lib/args';
import type { ScriptResult } from './lib/log';
import { report } from './lib/log';
import { appBin, generatorName } from './scaffold-first-run';

const SCRIPT = 'scaffold-admin';
const DEV_ACTOR = 'apps/web/app/auth/dev-actor.ts';
const MANIFEST = 'x.manifest.json';
/** How long `x dev` may take to answer its first request. Measured ~2 s; this is the kill-switch. */
const BOOT_BUDGET_MS = 60_000;

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

/** Everything the check touches outside its own arguments, so the whole of it runs under test. */
export interface AdminCheckIo {
  readonly boot: (dir: string, port: number) => DevServer;
  readonly fetcher: Fetcher;
  readonly port: () => number;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
}

const refused = (summary: string, cause: string, fix: string, at: string): ScriptResult => ({
  ok: false,
  script: SCRIPT,
  summary,
  findings: [{ code: 'X_SCAFFOLD_FIRST_RUN_FAILED', cause, fix, at }],
});

/** The last lines a server printed, on one line: what a boot that never answered has to say. */
const tail = (output: string): string =>
  output.trim().split('\n').slice(-6).join(' | ').slice(0, 600);

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
      // Quoted, not refused: `dir` is whatever path the caller handed this script, the line is pasted
      // whole, and `./my-app` — the common case — has to stay pasteable. A leading `-` is a flag.
      `bun run scripts/scaffold-first-run.ts ${quoteArg(dir.startsWith('-') ? '<app dir>' : dir)} && (cd ${quoteArg(dir.startsWith('-') ? '<app dir>' : dir)} && bin/setup)`,
      dir,
    );
  }
  // A missing `x` is not a refused admin: `bun install` never ran, and a spawn would say ENOENT.
  if (!(await Bun.file(appBin(dir)).exists())) {
    return refused(
      `no x binary at ${appBin(dir)}`,
      `${appBin(dir)} does not exist, so the scaffolded app cannot be booted`,
      `cd ${dir} && bin/setup`,
      dir,
    );
  }

  const port = io.port();
  // The NAME `x dev` binds, never a literal address: Bun binds `localhost` as `[::1]` alone on a
  // host whose hosts file maps it to both loopbacks (GitHub's Ubuntu runner), and a dial at
  // `127.0.0.1` there is refused for the whole budget while `x dev` reports itself ready.
  const base = `http://${DEV_BINDING.hostname}:${String(port)}`;
  const walk: AdminWalk = { base, resource, roleCookie };
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
  if (!up) {
    return refused(
      `x dev did not answer in ${dir}`,
      `x dev --port ${String(port)} answered no request in ${String(bootMs)} ms — the last dial at ${base}/admin: ${lastDial} — it printed: ${tail(output)}`,
      `cd ${dir} && bin/dev --port ${String(port)}`,
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

/** The real thing: the app's own `x dev`, a free port, the wall clock. */
const realIo: AdminCheckIo = {
  boot: (dir, port) => {
    const server = Bun.spawn([appBin(dir), 'dev', '--port', String(port), '--json'], {
      cwd: dir,
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
  // A port nothing holds right now, on the address `x dev` will bind — `dev-lock.ts`'s rule: probe
  // what the server binds. `x dev` takes the next one up for its sync node.
  port: () => {
    const probe = Bun.listen({
      hostname: DEV_BINDING.hostname,
      port: 0,
      socket: { data: () => undefined },
    });
    const { port } = probe;
    probe.stop(true);
    return port;
  },
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
