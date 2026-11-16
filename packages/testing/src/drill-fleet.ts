// A drill's fleet: the app's `web` and `worker` roles as separate processes (`apps/web/server.ts`
// under `ROLE`), on a scratch database it creates and drops, each dialling Postgres, Redis and
// NATS through a fault proxy of its own. The proxies are what the drill switches; the roles are
// what it signals; `beforeMigrate` starts the roles ahead of migrate instead. Nothing here judges.

// why: Bun ships no temp-directory primitive or recursive remove; `tmpdir()` is node:os's alone.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir() — only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path API — the state dir is joined, not concatenated.
import { join } from 'node:path';
import { tailOf } from './drill-output';
import { probeStatus } from './drill-probe';
import type { DrillRole, DrillService } from './drills';
import { E2eAppFailedError } from './e2e-errors';
import type { FaultProxy } from './fault-proxy';
import { faultProxy, faultTarget, throughFaultProxy } from './fault-proxy';
import { bindFreePorts, isPortClash } from './free-port-bind';
import { dropSql, urlFor } from './template-db';
import { testSealKeyEnv } from './test-seal-key';

export interface DrillServiceUrls {
  /** A Postgres URL with rights to CREATE DATABASE: the drill's scratch database is made there. */
  readonly postgres: string;
  readonly redis?: string | undefined;
  /** NATS, and the variable the app's `realtime.urlEnv` reads it from. */
  readonly nats?: { readonly url: string; readonly env: string } | undefined;
}

export interface DrillFleetOptions {
  readonly root: string;
  readonly services: DrillServiceUrls;
  readonly roles: readonly DrillRole[];
  readonly readyTimeoutMs: number;
  /** Extra environment for every role. */
  readonly env?: Readonly<Record<string, string>> | undefined;
  /**
   * The rollout-order drill: after the first migrate, `rewind` runs on the scratch database (the
   * caller's statement — the stamp is the CLI's to write), and the roles start WITHOUT waiting for
   * readiness, each line of their output naming `watch` counted. The fleet then has a `rollout`.
   */
  readonly beforeMigrate?: { readonly rewind: string; readonly watch: string } | undefined;
}

/** What a fleet started `beforeMigrate` adds: this release's migrate, and what each role did. */
export interface DrillRollout {
  /** `ROLE=migrate` on the direct URL; resolves once it exited 0, else the refusal is thrown. */
  migrate(): Promise<void>;
  /** The role's exit code, or `null` while its process runs. */
  exitCode(role: DrillRole): number | null;
  /** Output lines naming the fleet's `watch`, counted as they streamed — never cut by a tail. */
  watched(role: DrillRole): number;
}

export interface DrillRoleProcess {
  readonly role: DrillRole;
  /** `http://127.0.0.1:<PORT>`: the port the role was handed (`sync` binds its socket on PORT + 1). */
  readonly origin: string;
  /** `/readyz` on this role's own listener: the web port for `web`, the scrape port otherwise. */
  readonly readyz: string;
  signal(signal: 'SIGKILL' | 'SIGTERM'): void;
  /** The exit code, once the current process ends. */
  exited(): Promise<number>;
  /** A fresh process for the role on the same ports — what a supervisor does after a kill. */
  respawn(): Promise<void>;
  log(): string;
}

export interface DrillFleet {
  readonly base: string;
  /** The scratch database, dialled directly: the evidence's line, never the faulted one. */
  readonly databaseUrl: string;
  readonly proxies: ReadonlyMap<DrillService, FaultProxy>;
  readonly roles: ReadonlyMap<DrillRole, DrillRoleProcess>;
  /** Present when started with `beforeMigrate`. */
  readonly rollout?: DrillRollout | undefined;
  stop(): Promise<void>;
}

const SERVER = 'apps/web/server.ts';
const KILL_GRACE_MS = 5_000;

/** This process's environment minus every binding the fleet sets itself, and minus `NODE_ENV`. */
const inheritedEnv = (): Record<string, string | undefined> => {
  const {
    NODE_ENV: _node,
    DATABASE_URL: _db,
    REDIS_URL: _redis,
    NATS_URL: _nats,
    ...rest
  } = Bun.env;
  return rest;
};

const refuse = (step: string, output: string): E2eAppFailedError =>
  new E2eAppFailedError({
    step,
    output,
    fix: 'ROLE=web bun apps/web/server.ts   # in the app root, with the same DATABASE_URL: read why the role will not start',
  });

/** Create the scratch database on the admin URL; answers its own URL and its drop. */
async function scratchDatabase(adminUrl: string) {
  const name = `x_drill_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const admin = new Bun.SQL(adminUrl);
  try {
    await admin.unsafe(`create database ${name}`);
  } finally {
    await admin.close();
  }
  return {
    url: urlFor(adminUrl, name),
    async drop(): Promise<void> {
      const again = new Bun.SQL(adminUrl);
      try {
        await again.unsafe(dropSql(name));
      } finally {
        await again.close();
      }
    },
  };
}

async function waitReady(url: string, deadlineMs: number, alive: () => boolean): Promise<boolean> {
  const until = performance.now() + deadlineMs;
  while (performance.now() < until && alive()) {
    if ((await probeStatus(url, 1_000)) === 200) return true;
    await Bun.sleep(250);
  }
  return false;
}

/** The fleet, ready: database created and migrated, every proxy listening, every role answering. */
export async function startDrillFleet(options: DrillFleetOptions): Promise<DrillFleet> {
  const database = await scratchDatabase(options.services.postgres);
  const stateDir = await mkdtemp(join(tmpdir(), 'ultimate-drill-'));
  const proxies = new Map<DrillService, FaultProxy>();
  const roles = new Map<DrillRole, DrillRoleProcess>();
  const children = new Set<Bun.Subprocess>();
  const stop = async (): Promise<void> => {
    for (const child of children) child.kill('SIGKILL');
    await Promise.all([...children].map((child) => child.exited));
    for (const proxy of proxies.values()) proxy.close();
    await rm(stateDir, { recursive: true, force: true });
    await database.drop();
  };
  try {
    proxies.set('postgres', await faultProxy({ target: faultTarget(database.url) }));
    const redis = options.services.redis;
    if (redis !== undefined) proxies.set('redis', await faultProxy({ target: faultTarget(redis) }));
    const nats = options.services.nats;
    if (nats !== undefined)
      proxies.set('nats', await faultProxy({ target: faultTarget(nats.url) }));
    const via = (service: DrillService, url: string): string =>
      throughFaultProxy(url, proxies.get(service)?.port ?? 0);
    const base: Record<string, string> = {
      ...testSealKeyEnv({ root: options.root, env: { ...Bun.env, NODE_ENV: 'test' } }),
      // `test`, never `development`: a local environment (the throwaway seal key, no deploy-secret
      // refusal), without the development-only seams an app installs — a demo viewer answering
      // every request as ONE actor puts the whole load in one rate-limit bucket.
      ULTIMATE_ENV: 'test',
      // The load names a client per request in X-Forwarded-For, as an ingress does: without one
      // trusted hop every request is ONE client, and the rate limiter's 429 drowns the drill.
      TRUSTED_PROXY_HOPS: '1',
      ULTIMATE_STATE_DIR: stateDir,
      DATABASE_URL: via('postgres', database.url),
      ...(redis === undefined ? {} : { REDIS_URL: via('redis', redis) }),
      ...(nats === undefined ? {} : { [nats.env]: via('nats', nats.url) }),
      ...options.env,
    };
    const spawnRole = (env: Record<string, string>) => {
      const child = Bun.spawn(['bun', SERVER], {
        cwd: options.root,
        env: { ...inheritedEnv(), ...base, ...env },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      children.add(child);
      return child;
    };
    // The release phase on the DIRECT url: migrations are not what any drill faults.
    const migrate = async (): Promise<void> => {
      const job = spawnRole({ ROLE: 'migrate', DATABASE_URL: database.url });
      const output = tailOf([job.stdout, job.stderr]);
      // Bounded like a role's readiness: a wedged migration is a refusal, and `stop` SIGKILLs
      // it — it is still in `children`.
      const migrated = await Promise.race([
        job.exited,
        Bun.sleep(options.readyTimeoutMs).then(() => null),
      ]);
      if (migrated !== 0) throw refuse('ROLE=migrate', output.log());
      children.delete(job);
    };
    await migrate();
    const before = options.beforeMigrate;
    if (before !== undefined) {
      const direct = new Bun.SQL(database.url);
      await direct.unsafe(before.rewind).finally(() => direct.close());
    }

    const taken: number[] = [...[...proxies.values()].map((proxy) => proxy.port)];
    let webBase = '';
    // Each role's CURRENT process, read through: what the rollout reports on.
    const outputs = new Map<DrillRole, { exitCode(): number | null; watched(): number }>();
    for (const role of options.roles) {
      // Whether the last refusal was the role meeting a port another process took after it was
      // handed out — read off the full tail, which the refusal's cause holds a bounded copy of.
      let clashed = false;
      const started = await bindFreePorts(
        async ([port = 0, metricsPort = 0]) => {
          clashed = false;
          const origin = `http://127.0.0.1:${String(port)}`;
          const env = {
            ROLE: role,
            PORT: String(port),
            METRICS_PORT: String(metricsPort),
            APP_URL: origin,
          };
          const readyz =
            role === 'web' ? `${origin}/readyz` : `http://127.0.0.1:${String(metricsPort)}/readyz`;
          const child = spawnRole(env);
          const output = tailOf([child.stdout, child.stderr], before?.watch);
          // Before migrate, a role is not ready by design: what it does instead is the drill's
          // evidence, so its bind is proven by that evidence rather than here.
          if (before === undefined) {
            const ready = await waitReady(
              readyz,
              options.readyTimeoutMs,
              () => child.exitCode === null,
            );
            if (!ready) {
              clashed = isPortClash(output.log());
              children.delete(child);
              child.kill('SIGKILL');
              await child.exited;
              throw refuse(`ROLE=${role} never answered ${readyz}`, output.log());
            }
          }
          // The sync node listens on PORT + 1 (`syncPortFor`): held too, so no other role is handed it.
          taken.push(port, metricsPort, ...(role === 'sync' ? [port + 1] : []));
          return { origin, env, readyz, child, output };
        },
        { count: 2, pair: role === 'sync', apart: taken, clashed: () => clashed },
      );
      const { origin, env, readyz } = started;
      let { child, output } = started;
      if (role === 'web') webBase = origin;
      const boot = async (): Promise<void> => {
        const ready = await waitReady(
          readyz,
          options.readyTimeoutMs,
          () => child.exitCode === null,
        );
        if (!ready) throw refuse(`ROLE=${role} never answered ${readyz}`, output.log());
      };
      outputs.set(role, { exitCode: () => child.exitCode, watched: () => output.watched() });
      roles.set(role, {
        role,
        origin,
        readyz,
        signal: (signal) => child.kill(signal),
        exited: () => child.exited,
        async respawn() {
          children.delete(child);
          child = spawnRole(env);
          output = tailOf([child.stdout, child.stderr], before?.watch);
          await boot();
        },
        log: () => output.log(),
      });
    }
    const rollout: DrillRollout | undefined =
      before === undefined
        ? undefined
        : {
            migrate,
            exitCode: (role) => outputs.get(role)?.exitCode() ?? null,
            watched: (role) => outputs.get(role)?.watched() ?? 0,
          };
    return { base: webBase, databaseUrl: database.url, proxies, roles, rollout, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

/** A role's exit, or `null` past `withinMs`: SIGKILLed then, so a wedged drain ends the drill. */
export async function exitWithin(role: DrillRoleProcess, withinMs: number): Promise<number | null> {
  const exited = await Promise.race([role.exited(), Bun.sleep(withinMs).then(() => null)]);
  if (exited !== null) return exited;
  role.signal('SIGKILL');
  await Promise.race([role.exited(), Bun.sleep(KILL_GRACE_MS)]);
  return null;
}
