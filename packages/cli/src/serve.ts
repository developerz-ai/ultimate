// What a container starts. `apps/web/server.ts` is three lines that call `runRole`, so the boot a
// production process performs is framework code with tests rather than app code the author has to
// get right — and it is the SAME code `x dev` runs, minus the watcher, minus `/_x`, minus
// `dev: true`. The only production-shaped decisions live here: which role, which port, and which
// interface — every one by default, because a container is reached through a port mapping.

import { assertNoDevSecretsOutsideLocal, logger } from '@ultimat3/core';
import { assertNoDrift, checkDrift, migrate } from '@ultimat3/db';
import { loadAppRuntime } from './app-runtime';
import { acceptCreatedTables } from './db-accept-created';
import { holdUntilShutdown } from './hold';
import { startMetricsEndpoint } from './metrics-endpoint';
import { readMigrations } from './migrations';
import { resolveServices } from './runtime-bindings';
import { startQueue } from './runtime-queue';
import { startServices } from './runtime-services';
import { bootRoles } from './serve-boot';
import { containerBinding, metricsPortFor, portFromEnv, roleFromEnv } from './serve-env';
import type { MigratedApp, ServedApp, ServeOptions, StartedApp } from './serve-types';

export {
  CONTAINER_BINDING,
  configureReporting,
  containerBinding,
  DEFAULT_PORT,
  ERROR_DSN_KEY,
  hostnameFromEnv,
  metricsPortFor,
  metricsPortFromEnv,
  portFromEnv,
  roleFromEnv,
} from './serve-env';
export type { MigratedApp, ServedApp, ServeOptions, StartedApp } from './serve-types';

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
  const queue = await startQueue(
    resolveServices(options.root, options.env),
    options.runtime,
    options.env,
  );
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
/**
 * A caller's `runtime` wins; with none, the app's own `apps/<app>/runtime.ts` is what this boot
 * reads — the SAME file `x dev` reads — so the two boots compose one middleware chain, one
 * rate-limit store, one ISR store, rather than a development set and a production set. Resolved
 * ONCE, at each public entry, so every reader below (`startServices`, `startQueue`, the asset and
 * ISR seams, the replica override) sees one object: a per-read fallback would be the partial read
 * this repository names as its most repeated defect.
 */
export async function withAppRuntime(options: ServeOptions): Promise<ServeOptions> {
  if (options.runtime !== undefined) return options;
  const runtime = await loadAppRuntime(options.root);
  return runtime === undefined ? options : { ...options, runtime };
}

export async function serveApp(input: ServeOptions): Promise<ServedApp> {
  // FIRST, before any service starts: a production process on a key this framework publishes is
  // refused, rather than reported by `x doctor` and served anyway (plan 101, slices 01 e and 12 h).
  // The storage twin is `startStorage`'s own `LocalDiskUnsafeError`, one step later, where the
  // disk is chosen.
  assertNoDevSecretsOutsideLocal({ env: input.env });
  const options = await withAppRuntime(input);
  const role = options.role ?? roleFromEnv(options.env);
  // The scrape listener before ANY boot work — the services, the app's modules, the island build —
  // so a cold pod answers `/metrics` (and the chart's startup probe on it) while it boots. It was
  // opened inside `startRoles`, after all of that, so `_helpers.tpl`'s "FIRST" was not true.
  const port = options.port ?? portFromEnv(options.env);
  const metrics = startMetricsEndpoint({
    port: metricsPortFor(options.env, port, options.metricsPort),
    hostname: containerBinding(options.env, options.hostname).hostname,
  });
  // Everything acquired from here down, in order, so a throw anywhere below gives it all back.
  const acquired: (() => void | Promise<void>)[] = [() => metrics.stop()];
  try {
    const runtime = await startServices(
      resolveServices(options.root, options.env),
      options.env,
      options.runtime,
    );
    acquired.push(() => runtime.stop());
    return await bootRoles({ options, role, runtime, acquired, metrics });
  } catch (error) {
    await releaseBoot(acquired);
    throw error;
  }
}

/**
 * What `apps/web/server.ts` calls. Returns for `migrate` — the process is meant to exit — and
 * holds for every other role until core's drain completes, so SIGTERM from a rolling restart takes
 * the three-phase path (stop accepting, finish in-flight, close) instead of killing a query.
 */
export async function runRole(input: ServeOptions): Promise<StartedApp> {
  // The role FIRST: a bad `ROLE` is refused before the root is read at all, so a boot that was
  // always going to fail creates nothing under it — the same order `resolveServices` is held to.
  const role = input.role ?? roleFromEnv(input.env);
  const options = await withAppRuntime(input);
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
