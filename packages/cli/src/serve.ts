// What a container starts. `apps/web/server.ts` is three lines that call `runRole`, so the boot a
// production process performs is framework code with tests rather than app code the author has to
// get right — and it is the SAME code `x dev` runs, minus the watcher, minus `/_x`, minus
// `dev: true`. The only production-shaped decisions live here: which role, which port, and the
// fact that a container must bind every interface.

import type { Role } from '@ultimat3/core';
import {
  configureErrorReporting,
  isRole,
  logger,
  ROLES,
  sentryErrorReporter,
} from '@ultimat3/core';
import {
  assertNoDrift,
  checkDrift,
  type DriftReport,
  type MigrationReport,
  migrate,
} from '@ultimat3/db';
import type { Route } from '@ultimat3/http';
import { describeRoutes } from '@ultimat3/render';
import { createIsrController } from '@ultimat3/render/server';
import { apiRoutes } from './api-routes';
import { loadSignInPath } from './app-auth';
import { loadApp } from './app-load';
import { appManifest } from './app-manifest';
import { acceptCreatedTables } from './db-accept-created';
import { assetRoutes } from './dev-assets';
import { startQueue } from './dev-queue';
import { appRoutes } from './dev-render';
import { replicaOverrides } from './dev-replica';
import type { RunningRoles, WebBinding } from './dev-roles';
import { startRoles } from './dev-roles';
import type { RunningServices } from './dev-runtime';
import { startServices } from './dev-runtime';
import type { Env } from './dev-services';
import { resolveServices } from './dev-services';
import { storageRoutes } from './dev-storage';
import { PortInvalidError, RoleUnknownError } from './errors';
import { holdUntilShutdown } from './hold';
import { buildIslands } from './island-bundle';
import { islandRoutes } from './island-routes';
import { DEFAULT_METRICS_PORT } from './metrics-endpoint';
import { readMigrations } from './migrations';
import { startOtlpExport } from './otlp-export';
import { loadPwaArtifacts } from './pwa-artifacts';
import type { RuntimeOverrides } from './runtime-overrides';
import { serviceWorkerArtifacts, serviceWorkerRoutes } from './sw-artifacts';

export const DEFAULT_PORT = 3000;

/** Every interface. A container bound to loopback is unreachable through its own port mapping. */
export const CONTAINER_BINDING: WebBinding = { dev: false, hostname: '0.0.0.0' };

/**
 * `ROLE` is the one knob one image exposes. Validated rather than defaulted: a typo that fell back
 * to `web` would start a process that serves nothing the operator asked for and reports healthy.
 */
export function roleFromEnv(env: Env): Role {
  const raw = env['ROLE'] ?? 'web';
  if (!isRole(raw)) throw new RoleUnknownError({ role: raw, known: ROLES });
  return raw;
}

/**
 * `Number.parseInt` would read `80abc` as 80, so the whole string has to be a port — a
 * partially-parsed port is a deploy that binds somewhere nobody asked for.
 */
function portValue(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const port = Number(raw.trim());
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new PortInvalidError({ value: raw, name });
  return port;
}

/** Every PaaS injects `PORT` and routes traffic to exactly it. */
export function portFromEnv(env: Env): number {
  return portValue(env, 'PORT', DEFAULT_PORT);
}

/**
 * The scrape port, deliberately its own env var and not `PORT + n`: an operator who moves the app
 * port must not silently move the port their Prometheus is configured against, and the roles that
 * set no `PORT` at all — `worker`, `scheduler`, `replicator` — still need this one.
 */
export function metricsPortFromEnv(env: Env): number {
  return portValue(env, 'METRICS_PORT', DEFAULT_METRICS_PORT);
}

/**
 * The scrape port a boot uses, given the app port it already resolved. One expression, and it is
 * exported because `x dev` is the second caller: `cmd-dev.ts` passed no `metricsPort` at all, so
 * `METRICS_PORT` was honoured in the container and ignored on a laptop — the dev/prod parity break
 * `dev-roles.ts`'s own header forbids, and a second copy of this rule would be the same break
 * one edit later.
 *
 * An in-process caller asking for an ephemeral app port is a test, and a test that grabbed the
 * fixed 9090 would fail the next suite to boot beside it. An environment that names the port still
 * wins — that is the deploy talking.
 */
export const metricsPortFor = (env: Env, port: number, override?: number): number =>
  override ?? (port === 0 && env['METRICS_PORT'] === undefined ? 0 : metricsPortFromEnv(env));

/**
 * The one env var that turns error monitoring on, and the only vendor-shaped name in the boot
 * path. Not a platform primitive (axiom 7): the value is a URL to whatever the operator runs, the
 * wire format behind it is documented and self-hostable, and `SENTRY_DSN` is what every monitor
 * that speaks it already documents — inventing a second spelling would mean an operator's existing
 * tooling sets a variable this framework ignores. Exactly the precedent
 * `OTEL_EXPORTER_OTLP_ENDPOINT` already sets in `docker/helm/values.yaml`.
 */
export const ERROR_DSN_KEY = 'SENTRY_DSN';

/**
 * Switch reporting on for this process. Unset DSN leaves core's no-op reporter in place, so a
 * laptop and a CI run pay nothing and page nobody — and the release every event carries is the
 * build id this boot already computed, never a second identity for the same deploy.
 */
export function configureReporting(env: Env, buildId: string): void {
  const dsn = env[ERROR_DSN_KEY]?.trim();
  configureErrorReporting({
    release: buildId,
    // A malformed DSN throws here, at boot, rather than at the first outage: a monitor that was
    // never connected looks exactly like an app that never failed.
    ...(dsn === undefined || dsn.length === 0 ? {} : { reporter: sentryErrorReporter({ dsn }) }),
  });
}

export interface ServeOptions {
  readonly root: string;
  readonly env: Env;
  /** Overrides `ROLE`; `runRole` reads the environment when this is absent. */
  readonly role?: Role;
  /** Overrides `PORT`. 0 asks the kernel for an ephemeral one, which is what a test wants. */
  readonly port?: number;
  /** Overrides `METRICS_PORT`, on the same terms. */
  readonly metricsPort?: number;
  /**
   * The drivers this deployment supplies instead of the ones the environment would select.
   *
   * This field is why `apps/web/server.ts` can stay three lines and still run a custom queue, a
   * shared ISR store or an app's own middleware. Before it there was nowhere to hand the framework
   * a driver, so the only way was an ambient setter from an app module — which `loadApp` imports
   * AFTER `startServices` has captured its own, giving a process that enqueues to one queue and
   * claims from another. `startRoles` now refuses that split outright.
   */
  readonly runtime?: RuntimeOverrides;
}

export interface ServedApp {
  readonly kind: 'served';
  readonly role: Role;
  /** `http://…` for the web role; null for the roles that open no HTTP socket. */
  readonly url: string | null;
  readonly buildId: string;
  readonly running: RunningRoles;
  readonly runtime: RunningServices;
  stop(): Promise<void>;
}

export interface MigratedApp {
  readonly kind: 'migrated';
  readonly role: 'migrate';
  readonly report: MigrationReport;
  /** The post-condition: the live schema against the ledger this run just wrote. */
  readonly drift: DriftReport;
}

export type StartedApp = ServedApp | MigratedApp;

/**
 * The release phase, as a role. `migrate` is not a server: it applies the app's own migrations
 * through `@ultimat3/db`'s ledger — advisory lock, per-migration checksum, app-version fence — and
 * exits, so a platform that runs one container to completion before the rest start (Heroku's
 * release phase, a compose `service_completed_successfully`, a Kubernetes Job) has exactly one
 * thing to run and no framework-specific flag to learn.
 *
 * It boots the queue, not the whole runtime: this role touches the database and nothing else, and
 * `startQueue` is what installs `db()` for `migrate()` to find.
 *
 * The drift check is the post-condition, and it lives here rather than in `cmd-db.ts` for the same
 * reason the migrator does: it needs the connection this function opened, and a developer and a
 * release phase must not verify different things. It is **returned, never thrown** — the role's
 * contract is "apply every migration, then exit", and a schema difference after a clean apply is a
 * diagnostic, not a failed migration. `x db migrate` is where it is actionable, so `x db migrate`
 * is what fails on it.
 */
export async function runMigrations(options: ServeOptions): Promise<MigratedApp> {
  const queue = await startQueue(resolveServices(options.root, options.env), options.runtime);
  try {
    const migrations = await readMigrations(options.root);
    const report = await migrate({
      migrations,
      ...(options.env['APP_VERSION'] === undefined
        ? {}
        : { appVersion: options.env['APP_VERSION'] }),
    });
    logger.info('ultimate migrate applied', {
      applied: report.applied.length,
      available: migrations.length,
      appVersion: report.appVersion,
    });
    // Every migration above has just been applied, so a `create table` in one of them is proof
    // the app owns that relation — and a snapshot records only what ENTITIES declare, so without
    // this a hand-written table is `unexpected-table` on this deploy and on every deploy after it
    // (issue #345). Only that one difference, only for a name a migration's SQL creates.
    const drift = acceptCreatedTables(await checkDrift({ migrations }), migrations);
    // Logged with the first difference, not just a count: a release phase's log is the only place
    // an operator sees this, and "3 differences" names nothing to act on.
    if (!drift.ok) {
      logger.warn('ultimate migrate drift', {
        differences: drift.differences.length,
        cause: drift.differences[0]?.cause,
        fix: drift.differences[0]?.fix,
      });
    }
    return { kind: 'migrated', role: 'migrate', report, drift };
  } finally {
    await queue.stop();
  }
}

/**
 * Release what a boot acquired before it failed, newest first.
 *
 * Every failure here is swallowed, because the step that refused to start is the one worth
 * reporting — the same rule `startRoles`' own rollback runs by. Without it a throw between
 * `startServices` and `startRoles` left the Postgres pool, the queue and the OTLP exporter running
 * in a process whose caller has already given up: `x dev` and the container both retry the boot,
 * and the second attempt met a `.x/pgdata` the first one still held.
 */
export async function releaseBoot(
  acquired: readonly (() => void | Promise<void>)[],
): Promise<void> {
  for (const release of [...acquired].reverse()) {
    try {
      await release();
    } catch {
      // Deliberately empty: see above.
    }
  }
}

/**
 * Boot order is `x dev`'s, for the reason `x dev` gives: services, then the app's own modules
 * (importing them IS the registration), then the role that serves what they registered. The route
 * table is the same three contributions minus the dashboard — a `/_x` in production would expose
 * the app's policy matrix, its outbox and its spans to the internet.
 */
export async function serveApp(options: ServeOptions): Promise<ServedApp> {
  const role = options.role ?? roleFromEnv(options.env);
  const runtime = await startServices(
    resolveServices(options.root, options.env),
    options.env,
    options.runtime,
  );
  // Everything acquired from here down, in order, so a throw anywhere below gives it all back.
  const acquired: (() => void | Promise<void>)[] = [() => runtime.stop()];
  try {
    return await bootRoles({ options, role, runtime, acquired });
  } catch (error) {
    await releaseBoot(acquired);
    throw error;
  }
}

/** The half of `serveApp` whose every acquisition is registered for rollback. */
async function bootRoles(boot: {
  readonly options: ServeOptions;
  readonly role: Role;
  readonly runtime: RunningServices;
  readonly acquired: (() => void | Promise<void>)[];
}): Promise<ServedApp> {
  const { options, role, runtime, acquired } = boot;
  // Importing the app's modules IS the registration: every route, action and job below is
  // whatever this call put in the registries.
  await loadApp(options.root);
  // The build stamps `BUILD_ID` into the image; unstamped, the manifest's content hash is the same
  // answer computed here, so `x-ultimate-build` is never absent and never a lie. Projected only
  // when unstamped, because a stamped image already paid for it at build time and a replica's boot
  // should not repeat it — the load above is the part every boot needs either way.
  const stamped = options.env['BUILD_ID'];
  const buildId =
    stamped !== undefined && stamped.length > 0
      ? stamped
      : (await appManifest(options.root)).manifest.buildId;
  // Before the first socket opens: everything above this line fails loudly into the container's
  // own logs, everything below it is a served request, a claimed job or a routed frame.
  configureReporting(options.env, buildId);
  // Beside error reporting, and for the same reason it is here: `OTEL_EXPORTER_OTLP_ENDPOINT` is
  // in the shipped chart and nothing read it, so every deployment that configured a collector got
  // an empty dashboard. `x dev` keeps its own recorder — the `/_x` timeline is a different sink
  // with a different lifetime — so this is the production boot's alone (axiom 6).
  const stopOtlp = startOtlpExport(options.env);
  acquired.push(stopOtlp);
  // Built at boot rather than shipped prebuilt, so the container serves the same chunks `x dev`
  // does from the same source — the alternative is a second bundler invocation in the image build
  // whose output nothing compares against the one the dev loop proved.
  const islands = await buildIslands(options.root);
  // The same two strings `x dev` resolves, from the same reader: a `<link rel="manifest">` served
  // on a laptop and absent in the image is exactly the dev/prod difference this file exists to
  // prevent, and it is the one an operator cannot see without installing the app.
  const pwa = await loadPwaArtifacts(options.root);
  // The worker, from the SAME route table this process is about to serve — `describeRoutes()` is
  // the one projection `x.manifest.json`, `/_x`, the sitemap and `sw.js` are all built from, so a
  // route added here cannot be missing from the precache manifest.
  const serviceWorker =
    pwa === undefined
      ? undefined
      : serviceWorkerArtifacts({ pwa, buildId, routes: describeRoutes(), islands });
  const routes: readonly Route[] = [
    ...apiRoutes(),
    ...(serviceWorker === undefined ? [] : serviceWorkerRoutes(serviceWorker)),
    ...assetRoutes({
      root: options.root,
      storage: runtime.storage,
      ...(options.runtime?.images === undefined ? {} : { images: options.runtime.images }),
      ...(pwa === undefined ? {} : { pwa }),
    }),
    ...storageRoutes({ storage: runtime.storage }),
    ...islandRoutes(() => islands),
    ...appRoutes({
      buildId,
      resolveIsland: (file) => islands.resolverFor(file),
      ...(pwa === undefined ? {} : { pwaHead: pwa.head + (serviceWorker?.head ?? '') }),
      // Only when a store was supplied. `createIsrController` defaults to a per-process memory
      // store, so twelve replicas hold twelve of them and a purge tag regenerates one twelfth of
      // the fleet while the other eleven keep serving the page it just invalidated.
      ...(options.runtime?.isrStore === undefined
        ? {}
        : { isr: createIsrController({ buildId, store: options.runtime.isrStore }) }),
    }),
  ];
  const port = options.port ?? portFromEnv(options.env);
  // An in-process caller asking for an ephemeral app port is a test, and a test that grabbed the
  // fixed 9090 would fail the next suite to boot beside it. An environment that names the port
  // still wins — that is the deploy talking.
  const metricsPort = metricsPortFor(options.env, port, options.metricsPort);
  const replicaOverride = replicaOverrides(options.runtime, runtime.services.db, options.env);
  const running = await startRoles({
    roles: [role],
    port,
    metricsPort,
    buildId,
    runtime,
    routes,
    env: options.env,
    // Same declaration `x dev` reads. Without it a container answers a browser that opened a
    // guarded page with the problem document, rendered as raw JSON in the viewport.
    signInPath: await loadSignInPath(options.root),
    // The app's own `apps/web/site/errors/<status>.html`, resolved inside `startWeb` so this
    // process and `x dev` cannot answer a browser differently.
    root: options.root,
    http: CONTAINER_BINDING,
    // The read-replica scope rides in FRONT of whatever the host supplied, or the host's own value
    // passes through untouched. `DATABASE_REPLICA_URL` was read by no booted process before this:
    // `defaultClient()` is the one composer of a replicated pair and it runs only when an app
    // installed no client, which no framework boot leaves true (`dev-queue.ts`).
    ...(replicaOverride === undefined ? {} : { overrides: replicaOverride }),
  });
  acquired.push(() => running.stop());
  return {
    kind: 'served',
    role,
    url: running.url,
    buildId,
    running,
    runtime,
    async stop() {
      await running.stop();
      await runtime.stop();
      // Last: the exporters outlive the roles they were recording, so the drain's own spans and
      // the final counter snapshot still have somewhere to go.
      stopOtlp();
    },
  };
}

/**
 * What `apps/web/server.ts` calls. Returns for `migrate` — the process is meant to exit — and
 * holds for every other role until core's drain completes, so SIGTERM from a rolling restart takes
 * the three-phase path (stop accepting, finish in-flight, close) instead of killing a query.
 */
export async function runRole(options: ServeOptions): Promise<StartedApp> {
  const role = options.role ?? roleFromEnv(options.env);
  if (role === 'migrate') {
    const migrated = await runMigrations({ ...options, role });
    // The release phase has one channel — the exit code — so drift is thrown here rather than
    // returned. `x db migrate` calls the same `runMigrations` and renders every difference as a
    // finding before exiting non-zero; a container that logged one and exited 0 would let the
    // deploy roll on over a schema nobody can reconstruct, which is the failure drift exists for.
    assertNoDrift(migrated.drift);
    return migrated;
  }
  const app = await serveApp({ ...options, role });
  logger.info('ultimate started', { role: app.role, url: app.url, buildId: app.buildId });
  // `exit` because this is the one entry point with nothing above it: `bin.ts` ends in
  // `process.exit(code)` and `apps/web/server.ts` — which is what awaits this — does not. One
  // non-unref'd interval anywhere in the app then holds an event loop that has nothing left to do,
  // until `terminationGracePeriodSeconds` runs out and the kubelet SIGKILLs a drained process.
  await holdUntilShutdown('serve', () => app.stop(), {
    exit: (code) => {
      process.exit(code);
    },
  })();
  return app;
}
