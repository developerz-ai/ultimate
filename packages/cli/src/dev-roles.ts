// Running the roles. In production these are separate containers selected by `ROLE`; `x dev`
// runs them in one process by starting the same framework objects each container starts, so a
// job that only works when awaited inline still fails here.
//
// `migrate` is absent on purpose: it is run-once (`x db migrate`), not a process. `replicator` is
// selectable but not default — it takes a replication slot on a shared database, which is not
// something every `x dev` in a team should do to the same server by simply starting.

import type { Role } from '@ultimat3/core';
import { createContext, isRole, logger, ROLES } from '@ultimat3/core';
import type { Route, ServerHandle, ServerHooks } from '@ultimat3/http';
import { configuredAuthenticator, createServer, defineHttpConfig } from '@ultimat3/http';
import type { OutboxRelay, Scheduler, Worker } from '@ultimat3/jobs';
import {
  createOutboxRelay,
  createPgLeaseLeader,
  createScheduler,
  createWorker,
  jobDriver,
  pgSchedulerState,
} from '@ultimat3/jobs';
import { devHooks } from './dev-hooks';
import { pgExecutorFor } from './dev-queue';
import type { RunningReplicator } from './dev-replicator';
import { startReplicator } from './dev-replicator';
import type { RunningServices } from './dev-runtime';
import type { Env } from './dev-services';
import { startSync } from './dev-sync';
import { BadFlagError, PortInvalidError, RuntimeDriverSplitError } from './errors';
import { DEFAULT_METRICS_PORT, startMetricsEndpoint } from './metrics-endpoint';
import type { RuntimeOverrides } from './runtime-overrides';
import { inlineStyleSources } from './style-csp';

/** The roles `x dev` starts when `--role` names none, in boot order. */
export const DEV_ROLES: readonly Role[] = ['web', 'sync', 'worker', 'scheduler'];

/**
 * What `--role` accepts. The replicator is here but not in `DEV_ROLES`: opt-in, because it takes
 * the one replication slot a database has, and a default that did that would mean two developers
 * pointed at one staging database silently fighting over it.
 */
export const SELECTABLE_ROLES: readonly Role[] = [...DEV_ROLES, 'replicator'];

export interface StartRolesOptions {
  readonly roles: readonly Role[];
  readonly port: number;
  readonly buildId: string;
  readonly runtime: RunningServices;
  /** Routes the web role serves: `/_x`, the actions, the pages. */
  readonly routes: readonly Route[];
  /** The process environment, for the roles that resolve a driver from it. */
  readonly env: Env;
  /**
   * How the web role binds and what it admits about itself. `x dev` keeps the default —
   * loopback, `dev: true`, so a laptop on a café network is not serving the app to the café. A
   * container passes `{ dev: false, hostname: '0.0.0.0' }`: a process bound to `localhost` inside
   * a container is unreachable from the port mapping, the load balancer and every PaaS health
   * probe, which is the same failure in four costumes.
   */
  readonly http?: WebBinding;
  /**
   * The app's `auth.signInPath`. Threaded rather than read from the config here because
   * `startRoles` takes plain values — a test starts a web role with no `app.config.ts` at all.
   */
  readonly signInPath?: string | null;
  /**
   * Inline `<style>` bodies this process serves that the app's own surfaces do not account for —
   * `/_x`'s shell. The surfaces themselves are read from the stylesheet registry here rather than
   * passed, so no caller of `startRoles` can ship a web server whose CSP blocks the pages it
   * serves: that policy is what rendered every deployed app completely unstyled.
   */
  readonly inlineStyles?: readonly string[];
  /**
   * Non-fatal findings the browser overlay shows next to an error, for the request being answered.
   * Only `x dev` supplies one — `serve.ts` boots through this same function and omits it, so a
   * production process never has a diagnostic to call (axiom 6).
   */
  readonly devNotices?: ServerHooks['devNotices'];
  /**
   * Where the scrape listener binds. Defaults to `DEFAULT_METRICS_PORT`, except when `port` is 0
   * — a caller asking the kernel for an ephemeral HTTP port is a test, and a test that grabbed
   * 9090 would fail the next one to run beside it.
   */
  readonly metricsPort?: number;
  /**
   * What the host substituted for a boot decision. Read here for the three seams that are not
   * services — the rate-limit store, the middleware chain and the sync authenticator — while the
   * drivers themselves arrive already resolved on `runtime`.
   */
  readonly overrides?: RuntimeOverrides;
}

export interface WebBinding {
  readonly dev: boolean;
  readonly hostname: string;
}

/** Loopback and dev-mode. What `x dev` means, and what a container must override. */
export const DEV_BINDING: WebBinding = { dev: true, hostname: 'localhost' };

export interface RunningRoles {
  readonly roles: readonly Role[];
  /** `http://…` once the web role is up; null when it was not selected. */
  readonly url: string | null;
  /** Where the sync role accepts websockets; null when it was not selected. */
  readonly syncUrl: string | null;
  /** `http://…` — the scrape base. Never null: every role publishes a signal worth scaling on. */
  readonly metricsUrl: string;
  readonly server: ServerHandle | null;
  readonly worker: Worker | null;
  readonly scheduler: Scheduler | null;
  /** The slot and feed this process holds; null when the replicator was not selected. */
  readonly replicator: RunningReplicator | null;
  stop(): Promise<void>;
}

/**
 * `--role web,worker` picks a subset. An unknown or out-of-scope role is a flag error with the
 * working invocation in the fix line, never a silently ignored value — which is what it was.
 */
export function selectRoles(flag: string | undefined): readonly Role[] {
  if (flag === undefined || flag.trim().length === 0) return DEV_ROLES;
  const wanted = flag
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const selected: Role[] = [];
  for (const name of wanted) {
    if (!isRole(name)) {
      throw new BadFlagError({
        flag: 'role',
        command: 'dev',
        reason: `"${name}" is not a role (known: ${ROLES.join(', ')})`,
        fix: `x dev --role ${DEV_ROLES.join(',')}`,
      });
    }
    if (!SELECTABLE_ROLES.includes(name)) {
      throw new BadFlagError({
        flag: 'role',
        command: 'dev',
        reason: `"${name}" does not run under x dev (it runs once, as \`x db migrate\`)`,
        fix: `x dev --role ${DEV_ROLES.join(',')}`,
      });
    }
    if (!selected.includes(name)) selected.push(name);
  }
  return SELECTABLE_ROLES.filter((role) => selected.includes(role));
}

/**
 * A server whose route table demands an identity it has no way to resolve.
 *
 * `hooks.authenticate` is the only place an actor can come from, and `devHooks()` spreads nothing
 * when the app never called `configureAuthenticator()`. So a process in that state boots clean,
 * reports healthy, and refuses every valid session on every `auth: 'required'` route — which is
 * exactly what the demo app did: sign-in issued a real cookie and the next page still said 401,
 * while four unit tests over the app's own resolver stayed green because each installed a viewer
 * by hand.
 *
 * A warning and not a throw, deliberately: `x new` scaffolds guarded routes before it scaffolds an
 * authenticator, so an app in the minutes between the two is incomplete, not broken. It is loud,
 * it names the code, and it prints the call that fixes it.
 */
function warnIfUnauthenticatable(routes: readonly Route[]): void {
  if (configuredAuthenticator() !== undefined) return;
  const guarded = routes.filter((route) => route.meta.auth === 'required');
  if (guarded.length === 0) return;
  logger.warn(
    `X_CONFIG_INVALID: ${guarded.length} route(s) declare auth: 'required' and no authenticator is configured, so every request is anonymous and each of them refuses every session — fix: call configureAuthenticator() at module scope in a file under apps/*/, e.g. configureAuthenticator((request) => viewerFor(request.header('cookie')))`,
  );
}

/**
 * How many proxies append to `x-forwarded-for` between the client and this process, or `null`
 * when nothing in front of it is trusted.
 *
 * Read from the environment and not from `app.config.ts`, for the reason `PORT` and `ROLE` are: it
 * is a fact about the DEPLOYMENT — one image runs behind an ingress in one cluster and behind
 * nothing on a laptop — and an app that hardcoded it would be wrong in one of the two. `x dev`
 * sets neither and gets `trustProxy: false`, which is correct: there is no proxy.
 *
 * Without this seam a container behind an ingress reads `ctx.ip` as the ingress's own socket
 * address on every request, so the rate limiter keys the entire fleet's anonymous traffic into ONE
 * bucket and a single scanner 429s every real signup.
 */
export function trustedHopsFromEnv(env: Env): number | null {
  const raw = env['TRUSTED_PROXY_HOPS']?.trim();
  if (raw === undefined || raw === '') return null;
  const hops = Number(raw);
  // A malformed count is refused rather than defaulted: reading the header at the wrong index is
  // trusting a value the client typed, which is the failure trusting a proxy exists to avoid.
  if (!Number.isInteger(hops) || hops < 1 || hops > 16) {
    throw new PortInvalidError({ value: raw, name: 'TRUSTED_PROXY_HOPS' });
  }
  return hops;
}

function startWeb(options: StartRolesOptions): ServerHandle {
  warnIfUnauthenticatable(options.routes);
  const binding = options.http ?? DEV_BINDING;
  const hops = trustedHopsFromEnv(options.env);
  const store = options.overrides?.rateLimitStore;
  return createServer({
    routes: options.routes,
    role: 'web',
    hooks: devHooks(options.devNotices === undefined ? {} : { devNotices: options.devNotices }),
    // Both seams `createServer` already had and `startRoles` passed neither of, so an app's own
    // middleware could not reach the pipeline any process the framework boots actually runs.
    ...(options.overrides?.middleware === undefined
      ? {}
      : { middleware: options.overrides.middleware }),
    ...(store === undefined ? {} : { rateLimitStore: store }),
    config: defineHttpConfig({
      port: options.port,
      dev: binding.dev,
      buildId: options.buildId,
      hostname: binding.hostname,
      signInPath: options.signInPath ?? null,
      // One declaration, never half of one: `defineHttpConfig` refuses `trustProxy` without hops.
      ...(hops === null ? {} : { trustProxy: true, trustedProxyHops: hops }),
      // `scope` is mandatory since @ultimat3/http made an undeclared limiter a boot error: the
      // old `'process'` default meant the shipped chart's three `web` replicas enforced
      // `login: { limit: 5 }` as fifteen attempts, with `x verify` green. It is DERIVED from the
      // store rather than hardcoded — a deployment that hands `runtime.rateLimitStore` a shared
      // store is declaring the fleet-wide numbers, and `assertRateLimitScope` then holds the two
      // halves together instead of a literal here quietly contradicting the store beside it.
      rateLimit: { scope: store?.scope ?? 'process' },
      // Hashes, never `'unsafe-inline'`: a `render: 'static'` page is a file on disk, so
      // nothing can stamp a per-response nonce into it, but its body is fixed and a hash is a
      // function of that body. Read after `loadApp` — importing the app IS what registered them.
      security: {
        csp: { extend: { 'style-src': inlineStyleSources(options.inlineStyles ?? []) } },
      },
    }),
  }).start();
}

/**
 * The one moment the boot can still see both answers.
 *
 * `startServices` captures the drivers it built; `loadApp` imports the app's modules after it, and
 * a module calling `setJobDriver()` at import time moves the ambient slot and leaves the capture
 * alone. From here on the two are indistinguishable at every call site: `handle.enqueue()` reads
 * the ambient one, `createWorker` claims from the captured one, and `/_x` reads the ambient one —
 * so the dashboard agrees with the enqueue side and disagrees with reality.
 *
 * Refused, not reconciled. Reading through the accessor would make the split invisible instead of
 * impossible, and the app would still have installed a driver the boot never saw — no outbox store
 * bound to it, no relay draining it. The fix line names the field that does work.
 */
function assertOneJobDriver(runtime: RunningServices): void {
  const ambient = jobDriver();
  if (ambient === undefined || ambient === runtime.jobs) return;
  throw new RuntimeDriverSplitError({
    driver: 'jobs',
    ambient: ambient.name,
    captured: runtime.jobs.name,
  });
}

export async function startRoles(options: StartRolesOptions): Promise<RunningRoles> {
  const selected = options.roles;
  assertOneJobDriver(options.runtime);
  // Roles bind sockets in order, so a role that fails to start has to release the ones before it.
  // Without this a failed `sync` leaves the web server bound and unreachable by any caller.
  const started: (() => Promise<void>)[] = [];
  try {
    // First, and for every role rather than only the two that open an HTTP socket: `worker` and
    // `sync` are precisely the roles whose HPAs read a series the process itself has to publish,
    // and a `worker` container with no listener is an HPA pinned at `<unknown>` forever.
    const metrics = startMetricsEndpoint({
      port: options.metricsPort ?? (options.port === 0 ? 0 : DEFAULT_METRICS_PORT),
      ...(options.http === undefined ? {} : { hostname: options.http.hostname }),
    });
    started.push(async () => metrics.stop());

    const server = selected.includes('web') ? startWeb(options) : null;
    if (server !== null) started.push(() => server.stop());

    const sync = selected.includes('sync') ? await startSync(options) : null;
    if (sync !== null) started.push(sync.stop);

    const worker = selected.includes('worker')
      ? createWorker({
          driver: options.runtime.jobs,
          context: () => createContext({ role: 'worker', buildId: options.buildId }),
        })
      : null;
    worker?.start();
    if (worker !== null) started.push(() => worker.stop('x dev stopped'));

    // The half of the transactional outbox that makes a staged row a running job. Without it
    // `handle.enqueue()` inside a transaction writes to `x_outbox` and nothing ever reads it back
    // — every enqueue in a request handler silently becomes a job that never runs.
    //
    // On `worker`, and on `worker` alone: it is the role that exists wherever jobs run at all, and
    // a relay is safe to duplicate (publish-then-mark is at-least-once and the idempotency key
    // collapses the repeat) but pointless to spread. A deployment with no `worker` has no one to
    // run the jobs either way.
    const relay: OutboxRelay | null = selected.includes('worker')
      ? createOutboxRelay({ store: options.runtime.outbox, driver: options.runtime.jobs })
      : null;
    relay?.start();
    // Returned, not called-and-discarded: `stop()` waits out the pass in flight, and an unawaited
    // one hands the failure rollback the same window a dropped `await` gives the teardown below.
    if (relay !== null) started.push(() => relay.stop());

    // `state` and `leader`, not the defaults. `createMemorySchedulerState` forgets every watermark
    // on restart, so a rolling deploy re-fires or skips whatever was due across it, and
    // `soleLeader()` makes every replica the leader — three `scheduler` pods, three of every task.
    //
    // `createPgLeaseLeader` and NOT `createPgLeader`: the latter's `pg_try_advisory_lock` is
    // SESSION-scoped, and the session ends the moment the connection goes back to the pool, so
    // every node reads itself as leader anyway. An expiring row is correct on the executor this
    // package is actually handed.
    const executor = pgExecutorFor(options.runtime.db);
    const scheduler = selected.includes('scheduler')
      ? createScheduler({
          driver: options.runtime.jobs,
          state: pgSchedulerState(executor),
          leader: createPgLeaseLeader({ executor }),
        })
      : null;
    scheduler?.start();
    if (scheduler !== null) started.push(() => scheduler.stop());

    // Last, and only after the transport it publishes to exists: a replicator started ahead of the
    // sync node would decode changes with nothing subscribed to receive them, and the slot it
    // holds is the one resource here another process can be locked out of.
    const replicator = selected.includes('replicator')
      ? await startReplicator({
          services: options.runtime.services,
          env: options.env,
          transport: options.runtime.transport,
        })
      : null;
    if (replicator !== null) started.push(() => replicator.stop());

    return {
      roles: selected,
      url: server === null ? null : server.url(),
      syncUrl: sync?.url ?? null,
      metricsUrl: metrics.url,
      server,
      worker,
      scheduler,
      replicator,
      async stop() {
        // Reverse boot order, so the slot is released before the bus it published to closes.
        await replicator?.stop();
        await scheduler?.stop();
        // Before the worker, so nothing publishes into a queue whose consumer has already gone —
        // and AWAITED, because a pass is a `driver.enqueue` followed by a `markPublished`. Dropped,
        // this returns between the two and the lines below close the pool under the row it was
        // about to mark: re-published next boot at best, a rejection against a closed pool at worst.
        await relay?.stop();
        await worker?.stop('x dev stopped');
        await sync?.stop();
        await server?.stop();
        // Last: a scrape taken while the roles above drain is the one that explains the drain.
        metrics.stop();
      },
    };
  } catch (error) {
    for (const stop of started.reverse()) {
      // The role that refused to start is the failure worth reporting, not a stop on the way out.
      await stop().catch(() => undefined);
    }
    throw error;
  }
}
