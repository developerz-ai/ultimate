// Running the roles. In production these are separate containers selected by `ROLE`; `x dev`
// runs them in one process by starting the same framework objects each container starts, so a
// job that only works when awaited inline still fails here.
//
// `migrate` is absent on purpose: it is run-once (`x db migrate`), not a process. `replicator` is
// selectable but not default — it takes a replication slot on a shared database, which is not
// something every `x dev` in a team should do to the same server by simply starting.

import type { Role } from '@ultimat3/core';
import { ctxOf, isRole, logger, markReady, ROLES } from '@ultimat3/core';
import { dbExecutor } from '@ultimat3/db';
import type { RateLimitStore, Route, ServerHandle, WebSocketMount } from '@ultimat3/http';
import {
  adoptRateLimitStore,
  configuredAuthenticator,
  configuredHttp,
  defineHttpConfig,
  httpServer,
  mergeHttpConfig,
} from '@ultimat3/http';
import type { OutboxRelay } from '@ultimat3/jobs';
import {
  jobDriver,
  jobScheduler,
  jobWorker,
  outboxRelay,
  postgresLeaseLeader,
  postgresSchedulerState,
} from '@ultimat3/jobs';
import type { SyncWs } from '@ultimat3/realtime/server';
import { errorPageHook } from './error-pages';
import { BadFlagError, RuntimeDriverSplitError } from './errors';
import {
  DEFAULT_METRICS_PORT,
  startMetricsEndpoint,
  whenMetricsPortTaken,
} from './metrics-endpoint';
import { rolesUnderRealtime } from './role-realtime';
import { startReplicator } from './role-replicator';
import type { RunningRoles, StartRolesOptions } from './role-start-types';
import { DEV_ROLES } from './role-start-types';
import { prepareSync, type RunningSync } from './role-sync';
import { startWorkerWake } from './role-wake';
import { devHooks } from './runtime-hooks';
import { workerOptionsFor } from './runtime-jobs';
import { startLiveFeed } from './runtime-live-feed';
import { type RunningServices, releaseOrThrow } from './runtime-services';
import { inlineScriptSources } from './script-csp';
import { inlineStyleSources } from './style-csp';
import { syncConnectSources } from './sync-url';
import { trustedHopsFromEnv } from './trusted-hops';
import { DEV_BINDING } from './web-binding';

// Declared beside the option types so `x dev`'s spec reads it without loading this module.
export { DEV_ROLES } from './role-start-types';

/**
 * What `--role` accepts. The replicator is here but not in `DEV_ROLES`: opt-in, because it takes
 * the one replication slot a database has, and a default that did that would mean two developers
 * pointed at one staging database silently fighting over it.
 */
export const SELECTABLE_ROLES: readonly Role[] = [...DEV_ROLES, 'replicator'];

// The two shapes this module takes and answers, in a file of their own at the line ceiling.
export type { RunningRoles, StartRolesOptions } from './role-start-types';

// Re-exported, not re-declared: `web-binding.ts` is a leaf so `role-sync` can read the default
// without importing this module, which imports it.
export { DEV_BINDING, type WebBinding } from './web-binding';

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

// `trusted-hops.ts` owns the read; re-exported because callers and tests already name it here.
export { trustedHopsFromEnv } from './trusted-hops';

/**
 * A deployment that substituted a PER-PROCESS store is enforcing every declared number once per
 * replica, and the shipped chart runs three. Not refused — `assertRateLimitScope` only fires on a
 * `'shared'` declaration, and the scope below is DERIVED from the store, so the two can never
 * contradict each other — but the multiplier is stated, in the `warnIfUnauthenticatable` shape:
 * loud, coded, and naming the call that fixes it.
 *
 * Only for a store the host SUPPLIED. A boot with no store at all resolved one of its own
 * (`startServices`), so the remaining silent case is a hand-built `RunningServices` in a test.
 */
function warnIfProcessScoped(store: RateLimitStore): void {
  if (store.scope === 'shared') return;
  logger.warn(
    `X_CONFIG_INVALID: the rate-limit store this deployment passed keeps its counters per process, so every limit the app declares is enforced once per replica — docker/helm/values.yaml runs roles.web.replicas: 3, which is 3x every number — fix: drop runtime.rateLimitStore and the boot installs postgresRateLimitStore({ executor }) on the pool it already opened`,
  );
}

/**
 * Where this web role's limiter keeps its counters: what the deployment SUBSTITUTED, else the
 * shared Postgres store `startServices` resolved over the pool this boot already opened.
 *
 * One expression, one answer, in the order `RuntimeOverrides` documents — an override REPLACES the
 * resolved default rather than sitting beside it. `undefined` is reachable only from a hand-built
 * runtime, which is `httpServer`'s per-process memory store and `scope: 'process'` below.
 */
function rateLimitStoreFor(options: StartRolesOptions): RateLimitStore | undefined {
  const supplied = options.overrides?.rateLimitStore;
  if (supplied === undefined) return options.runtime.rateLimitStore;
  warnIfProcessScoped(supplied);
  return supplied;
}

/** `mount` is the sync node's socket, served on THIS port as well as its own — why, in `role-sync`.
 * Undefined without the `sync` role, and then this server opens no websocket, as it always did. */
function startWeb(options: StartRolesOptions, mount?: WebSocketMount<SyncWs>): ServerHandle {
  warnIfUnauthenticatable(options.routes);
  const binding = options.http ?? DEV_BINDING;
  const hops = trustedHopsFromEnv(options.env);
  const store = rateLimitStoreFor(options);
  return httpServer({
    routes: options.routes,
    role: 'web',
    ...(mount === undefined ? {} : { websocket: mount }),
    ...(options.drain === undefined ? {} : { drain: options.drain }),
    hooks: devHooks({
      ...(options.devNotices === undefined ? {} : { devNotices: options.devNotices }),
      ...(options.root === undefined
        ? {}
        : { errorPage: errorPageHook(options.root, { perRequest: binding.dev }) }),
    }),
    // Both seams `httpServer` already had and `startRoles` passed neither of, so an app's own
    // middleware could not reach the pipeline any process the framework boots actually runs.
    ...(options.overrides?.middleware === undefined
      ? {}
      : { middleware: options.overrides.middleware }),
    ...(store === undefined ? {} : { rateLimitStore: store }),
    // The app's own declaration UNDERNEATH, this boot's facts on top. Without the first half the
    // entire HTTP tuning surface was unreachable from a shipped app — this literal was its only
    // construction, so `cors.origins` stayed `[]` in every deployment (no cross-origin call could
    // ever succeed), `bodyLimitBytes` stayed 1 MiB and `requestTimeoutMs` 30s for a bank and a
    // blog alike. The ORDER is not a preference: `buildId`, the port, the CSP hashes of what this
    // process emits and the scope of the store it installed are facts only the boot has.
    config: defineHttpConfig(
      mergeHttpConfig(configuredHttp(), {
        port: options.port,
        dev: binding.dev,
        buildId: options.buildId,
        hostname: binding.hostname,
        signInPath: options.signInPath ?? null,
        // One declaration, never half of one: `defineHttpConfig` refuses `trustProxy` without hops.
        ...(hops === null ? {} : { trustProxy: true, trustedProxyHops: hops }),
        // `scope` is mandatory since @ultimat3/http made an undeclared limiter a boot error, and it
        // is DERIVED from the store rather than hardcoded — a literal here would be a second
        // declaration quietly contradicting the object beside it, and `assertRateLimitScope` holds
        // the two halves together. It answered `'process'` on every real boot until `startServices`
        // resolved a store, so the shipped chart's three `web` replicas enforced
        // `login: { limit: 5 }` as fifteen attempts, with `x verify` green.
        rateLimit: { scope: store?.scope ?? 'process' },
        // Hashes, never `'unsafe-inline'`: a `render: 'static'` page is a file on disk, so
        // nothing can stamp a per-response nonce into it, but its body is fixed and a hash is a
        // function of that body. BOTH directives: the hydration runtime is emitted inline in every
        // document that carries an island, so `script-src 'self'` meant no island booted anywhere
        // the policy is enforced — every container, and never `x dev`, where it is report-only.
        security: {
          csp: {
            extend: {
              'style-src': inlineStyleSources(options.inlineStyles ?? []),
              'script-src': inlineScriptSources(options.inlineScripts ?? []),
              // A sync node on ANOTHER origin (`SYNC_URL`), admitted by that origin alone — the
              // baseline's `'self'` is every same-origin rung.
              'connect-src': syncConnectSources(options.env),
            },
          },
        },
      }),
    ),
  }).start();
}

/**
 * The one moment the boot can still see both answers.
 *
 * `startServices` captures the drivers it built; `loadApp` imports the app's modules after it, and
 * a module calling `setJobDriver()` at import time moves the ambient slot and leaves the capture
 * alone. From here on the two are indistinguishable at every call site: `handle.enqueue()` reads
 * the ambient one, `jobWorker` claims from the captured one, and `/_x` reads the ambient one —
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
  // `realtime.enabled` read here, before anything binds: a refusal leaves nothing to unwind.
  const selected = rolesUnderRealtime(
    options.roles,
    options.runtime.realtime,
    (options.http ?? DEV_BINDING).dev,
  );
  assertOneJobDriver(options.runtime);
  // Roles bind sockets in order, so a role that fails to start has to release the ones before it.
  // Without this a failed `sync` leaves the web server bound and unreachable by any caller.
  const started: (() => Promise<void>)[] = [];
  try {
    // Every role, before any can serve: an action's or a query's declared `rateLimit:` is spent
    // inside the primitive (`invoke`, the read path) on every surface — a `worker` running
    // `.job()`s as much as `web` — and counted in the installed store. The SAME instance the web
    // role's limiter gets below (`rateLimitStoreFor` is the one decision), so one replica's MCP
    // call and another's HTTP call spend one bucket in one table.
    // A frame of its own over what `startServices` adopted, popped by its own undo — so stopping
    // these roles takes back exactly this install, whatever else stacked over or under it.
    const limits = rateLimitStoreFor(options);
    const restoreLimits = limits === undefined ? () => undefined : adoptRateLimitStore(limits);
    started.push(async () => restoreLimits());
    // First, and for every role rather than only the two that open an HTTP socket: `worker` and
    // `sync` are precisely the roles whose HPAs read a series the process itself has to publish,
    // and a `worker` container with no listener is an HPA pinned at `<unknown>` forever.
    // `?? DEV_BINDING`, not "omit the key when `options.http` is undefined". The old spread left
    // the metrics endpoint on Bun's `0.0.0.0` for exactly the caller that asked for loopback —
    // `x dev`, which passes no `http` at all — so the same gap the sync node had was here too.
    const binding = options.http ?? DEV_BINDING;
    // A container's boot opened it already, before its slow work (`serve-boot.ts`): adopted.
    const metrics =
      options.metrics ??
      startMetricsEndpoint({
        port: options.metricsPort ?? (options.port === 0 ? 0 : DEFAULT_METRICS_PORT),
        hostname: binding.hostname,
        // `x dev` is one process running several roles: its `process_info` says which.
        role: selected.join('+'),
        whenTaken: whenMetricsPortTaken(binding.dev, options.env),
      });
    started.push(async () => metrics.stop());
    // Opened here or adopted from `serve-boot.ts`, this is where the build id is known (#734).
    metrics.announceBuild(options.buildId);

    // BUILT here, BOUND below, the web role between them: `web` serves the node's socket on its
    // own port and a listening server cannot be handed one, while the neighbouring-port refusals
    // are only the right answer once the web port's own has been given.
    const prepared = selected.includes('sync') ? await prepareSync(options) : null;
    // One rollback entry, kept current — two would stop the node twice out of a failed boot. It
    // goes on the list AFTER the server's, because the list is also the stop order (newest
    // first): the node's listener closes before the web server drains, as it always has. The
    // window between — `startWeb` refusing — releases the prepared node itself.
    let releaseSync = prepared?.stop ?? null;
    let server: ServerHandle | null;
    try {
      server = selected.includes('web') ? startWeb(options, prepared?.mount) : null;
    } catch (error) {
      await releaseSync?.().catch(() => undefined);
      throw error;
    }
    if (server !== null) {
      const web = server;
      started.push(() => web.stop());
    }
    if (prepared !== null) started.push(async () => await releaseSync?.());

    const sync: RunningSync | null =
      prepared === null ? null : await prepared.listen(server === null ? null : server.url());
    if (sync !== null) releaseSync = sync.stop;

    const worker = selected.includes('worker')
      ? jobWorker({
          driver: options.runtime.jobs,
          context: () => ctxOf({ role: 'worker', buildId: options.buildId }),
          ...workerOptionsFor(options.runtime.workerConfig),
        })
      : null;
    worker?.start();
    if (worker !== null) started.push(() => worker.stop('x dev stopped'));

    // The half of the transactional outbox that makes a staged row a running job. Without it
    // `handle.enqueue()` inside a transaction writes to `x_outbox` and nothing ever reads it back
    // — every enqueue in a request handler silently becomes a job that never runs.
    //
    // On `worker`, and on `worker` alone: it is the role that exists wherever jobs run at all, and
    // a relay is safe to duplicate — the claim is a LEASE taken in the statement that locks the
    // row, so two relays never hold one batch — but pointless to spread. The idempotency key is
    // not the reason and never was: its conflict target is a partial index over live states, so it
    // collapses a repeat only while the first job is still live. A deployment with no `worker` has
    // no one to run the jobs either way.
    const relay: OutboxRelay | null = selected.includes('worker')
      ? outboxRelay({ store: options.runtime.outbox, driver: options.runtime.jobs })
      : null;
    relay?.start();
    // Returned, not called-and-discarded: `stop()` waits out the pass in flight, and an unawaited
    // one hands the failure rollback the same window a dropped `await` gives the teardown below.
    if (relay !== null) started.push(() => relay.stop());

    // The cross-process wake: one LISTEN session, so a job another pod committed starts now
    // instead of at the next poll. On `worker` alone — it is the role whose two loops (the claim
    // and the relay above) hear it; a web or scheduler pod holding a session would pin a
    // connection per replica to wake nothing (`role-wake.ts`).
    const wake = selected.includes('worker') ? startWorkerWake(options.runtime.db) : null;
    if (wake !== null) started.push(() => wake.stop());

    // `state` and `leader`, not the defaults. `memorySchedulerState` forgets every watermark
    // on restart, so a rolling deploy re-fires or skips whatever was due across it, and
    // `soleLeader()` makes every replica the leader — three `scheduler` pods, three of every task.
    //
    // `postgresLeaseLeader` and NOT `postgresLeader`: the latter's `pg_try_advisory_lock` is
    // SESSION-scoped, and the session ends the moment the connection goes back to the pool, so
    // every node reads itself as leader anyway. An expiring row is correct on the executor this
    // package is actually handed.
    const executor = dbExecutor(() => options.runtime.db);
    const scheduler = selected.includes('scheduler')
      ? jobScheduler({
          driver: options.runtime.jobs,
          state: postgresSchedulerState(executor),
          leader: postgresLeaseLeader({ executor }),
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
          dev: binding.dev,
        })
      : null;
    if (replicator !== null) started.push(() => replicator.stop());

    // What feeds the sync node this process booted. The embedded database has no log to decode,
    // so under it the node is fed by this process's own repository writes (`runtime-live-feed.ts`);
    // with a real database the WAL decoder above is the feed, here or in another process.
    const live = await startLiveFeed({
      sync,
      dbMode: options.runtime.services.db.mode,
      transport: options.runtime.transport.name,
      replicatorHere: replicator !== null,
    });
    started.push(async () => live.stop());
    // The web server and the sync node mark ready when they bind; a process with neither — a
    // worker, scheduler or replicator pod — is ready once its roles started, which is what the
    // scrape port's `/readyz` answers (`metrics-endpoint.ts`). The checks still decide after this.
    if (server === null && sync === null) markReady();

    return {
      roles: selected,
      url: server === null ? null : server.url(),
      syncUrl: sync?.url ?? null,
      metricsUrl: metrics.url,
      server,
      worker,
      scheduler,
      replicator,
      liveFeed: live.feed,
      liveBridge: live.bridge,
      liveRegistry: sync?.registry ?? null,
      async stop() {
        // `started` IS the stop list, in boot order: released newest first — the live feed, the
        // replicator (so the slot is released before the bus it published to closes), the
        // scheduler, the wake session, the relay (awaited: a pass is an enqueue then a
        // `markPublished`, and a pool closed between the two re-publishes next boot), the worker,
        // the sync node, the server, the metrics listener (a scrape taken mid-drain explains the
        // drain) and, after every role that could spend from it, the rate-limit store. EVERY step
        // runs: one rejection used to skip the rest. One list, so the rollback and the stop cannot
        // drift apart.
        await releaseOrThrow(started);
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
