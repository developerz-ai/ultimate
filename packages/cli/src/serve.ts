// What a container starts. `apps/web/server.ts` is three lines that call `runRole`, so the boot a
// production process performs is framework code with tests rather than app code the author has to
// get right — and it is the SAME code `x dev` runs, minus the watcher, minus `/_x`, minus
// `dev: true`. The only production-shaped decisions live here: which role, which port, and the
// fact that a container must bind every interface.

import { listActions, toRoute } from '@ultimat3/action';
import type { Role } from '@ultimat3/core';
import { isRole, logger, ROLES } from '@ultimat3/core';
import { type MigrationReport, migrate } from '@ultimat3/db';
import type { Route } from '@ultimat3/http';
import { loadApp } from './app-load';
import { appManifest } from './app-manifest';
import { assetRoutes } from './dev-assets';
import { startQueue } from './dev-queue';
import { appRoutes } from './dev-render';
import type { RunningRoles, WebBinding } from './dev-roles';
import { startRoles } from './dev-roles';
import type { RunningServices } from './dev-runtime';
import { startServices } from './dev-runtime';
import type { Env } from './dev-services';
import { resolveServices } from './dev-services';
import { PortInvalidError, RoleUnknownError } from './errors';
import { holdUntilShutdown } from './hold';
import { DEFAULT_METRICS_PORT } from './metrics-endpoint';
import { readMigrations } from './migrations';

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

export interface ServeOptions {
  readonly root: string;
  readonly env: Env;
  /** Overrides `ROLE`; `runRole` reads the environment when this is absent. */
  readonly role?: Role;
  /** Overrides `PORT`. 0 asks the kernel for an ephemeral one, which is what a test wants. */
  readonly port?: number;
  /** Overrides `METRICS_PORT`, on the same terms. */
  readonly metricsPort?: number;
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
 */
export async function runMigrations(options: ServeOptions): Promise<MigratedApp> {
  const queue = await startQueue(resolveServices(options.root, options.env));
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
    return { kind: 'migrated', role: 'migrate', report };
  } finally {
    await queue.stop();
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
  const runtime = await startServices(resolveServices(options.root, options.env), options.env);
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
  const routes: readonly Route[] = [
    ...listActions().map(toRoute),
    ...assetRoutes({ root: options.root, storage: runtime.storage }),
    ...appRoutes({ buildId }),
  ];
  const port = options.port ?? portFromEnv(options.env);
  // An in-process caller asking for an ephemeral app port is a test, and a test that grabbed the
  // fixed 9090 would fail the next suite to boot beside it. An environment that names the port
  // still wins — that is the deploy talking.
  const metricsPort =
    options.metricsPort ??
    (port === 0 && options.env['METRICS_PORT'] === undefined ? 0 : metricsPortFromEnv(options.env));
  const running = await startRoles({
    roles: [role],
    port,
    metricsPort,
    buildId,
    runtime,
    routes,
    env: options.env,
    http: CONTAINER_BINDING,
  });
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
  if (role === 'migrate') return runMigrations({ ...options, role });
  const app = await serveApp({ ...options, role });
  logger.info('ultimate started', { role: app.role, url: app.url, buildId: app.buildId });
  await holdUntilShutdown('serve', () => app.stop())();
  return app;
}
