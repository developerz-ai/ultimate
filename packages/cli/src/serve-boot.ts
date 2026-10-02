// The serving roles' boot: the services started, the app loaded, its route table built, the roles
// started. Behind ONE `await import()` in `serve.ts` (the entry points), so `ROLE=migrate` loads
// none of it; the rules that file's header states — the SAME boot `x dev` runs, minus the watcher,
// `/_x` and `dev: true` — are this file's. A role imports what it runs: the web surface
// (`serve-web.ts`) and the manifest projection are behind `await import()` in turn, so a worker's
// module graph holds neither.

import type { Role } from '@ultimat3/core';
import { configureLifecycle, logger } from '@ultimat3/core';
import type { MetricsEndpoint } from './metrics-endpoint';
import { startOtlpExport } from './otlp-export';
import { loadAppForRole, roleLoadFor } from './role-load';
import { startRoles } from './role-start';
import { resolveServices } from './runtime-bindings';
import { replicaOverrides } from './runtime-replica';
import type { RunningServices } from './runtime-services';
import { startServices } from './runtime-services';
import { loadDrainConfig, loadHealthConfig } from './serve-drain';
import { configureReporting, containerBinding, metricsPortFor, portFromEnv } from './serve-env';
import { adoptPrebuiltStyles, reportBootBuilds, watchBootBuilds } from './serve-prebuilt';
import type { ServedApp, ServeOptions } from './serve-types';

/**
 * The build stamps `BUILD_ID` into the image; unstamped, the manifest's content hash is the same
 * answer computed here, so `x-ultimate-build` is never absent and never a lie. Projected only when
 * unstamped, because a stamped image already paid for it at build time and a replica's boot should
 * not repeat it. The projection describes the WHOLE app — routes included — so an unstamped worker
 * imports everything its own load left out, and says so.
 */
async function buildIdFor(options: ServeOptions, role: Role): Promise<string> {
  const stamped = options.env['BUILD_ID'];
  if (stamped !== undefined && stamped.length > 0) return stamped;
  if (roleLoadFor(role) === 'background') {
    logger.warn('ultimate build id unstamped', {
      role,
      cause:
        'BUILD_ID is unset, so this role imported every page of the app to compute the build id the web role serves',
      fix: 'x build --target docker',
    });
  }
  const { appManifest } = await import('./app-manifest');
  return (await appManifest(options.root)).manifest.buildId;
}

/**
 * Everything `serveApp` does after the scrape listener is open: the services, then the roles over
 * them. One export, so `serve.ts` reaches the whole serving graph through ONE `await import()`.
 */
export async function bootServing(boot: {
  readonly options: ServeOptions;
  readonly role: Role;
  readonly acquired: (() => void | Promise<void>)[];
  readonly metrics: MetricsEndpoint;
}): Promise<ServedApp> {
  const { options } = boot;
  const runtime = await startServices(
    resolveServices(options.root, options.env),
    options.env,
    options.runtime,
  );
  boot.acquired.push(() => runtime.stop());
  return bootRoles({ ...boot, runtime });
}

/** The half of `serveApp` whose every acquisition is registered for rollback. */
async function bootRoles(boot: {
  readonly options: ServeOptions;
  readonly role: Role;
  readonly runtime: RunningServices;
  readonly acquired: (() => void | Promise<void>)[];
  /** The scrape listener `serveApp` opened before any of this work; `startRoles` adopts it. */
  readonly metrics: MetricsEndpoint;
}): Promise<ServedApp> {
  const { options, role, runtime, acquired, metrics } = boot;
  // The image's compiled stylesheets, before the first page is imported — importing one IS
  // compiling its sheet — and the count of what this boot compiles anyway.
  adoptPrebuiltStyles(options.root);
  const bootBuilds = watchBootBuilds();
  // Importing the app's modules IS the registration: every route, action and job below is
  // whatever this call put in the registries — for THIS role (`role-load.ts`).
  const loaded = await loadAppForRole(options.root, role);
  // A module that would not import registered nothing, and a process that only logs the roles it
  // started gives no sign of it: each one is a line an operator can act on.
  for (const finding of loaded.findings) {
    logger.error('ultimate app module failed to load', { role, ...finding });
  }
  const buildId = await buildIdFor(options, role);
  // Before the first socket opens: everything above this line fails loudly into the container's
  // own logs, everything below it is a served request, a claimed job or a routed frame.
  configureReporting(options.env, buildId);
  // Beside error reporting, and for the same reason it is here: `OTEL_EXPORTER_OTLP_ENDPOINT` is
  // in the shipped chart and nothing read it, so every deployment that configured a collector got
  // an empty dashboard. `x dev` keeps its own recorder — the `/_x` timeline is a different sink
  // with a different lifetime — so this is the production boot's alone (axiom 6).
  const stopOtlp = startOtlpExport(options.env);
  acquired.push(stopOtlp);
  // Only the web role serves pages, so only it builds islands and assembles a route table: a
  // worker, scheduler, sync or replicator pod compiled every island of the app on every boot for
  // nothing it would ever serve (plan 101, slice 12 e). The MODULE is the web role's as well —
  // imported here, it is render, PWA, SEO and MCP code no other role evaluates.
  const web =
    role === 'web'
      ? await (await import('./serve-web')).webSurface(options, runtime, buildId)
      : undefined;
  // Islands and stylesheets are the image build's to make (`x build --target prebuilt`). A role
  // that made either here served correctly and paid for it — seconds of CPU and a compiler's
  // memory, on every start of every replica — so it says so once, with the Dockerfile line.
  reportBootBuilds(role, bootBuilds(web?.islandsBuilt));
  const port = options.port ?? portFromEnv(options.env);
  // An in-process caller asking for an ephemeral app port is a test, and a test that grabbed the
  // fixed 9090 would fail the next suite to boot beside it. An environment that names the port
  // still wins — that is the deploy talking.
  const metricsPort = metricsPortFor(options.env, port, options.metricsPort);
  const drain = await loadDrainConfig(options.root);
  // Process-wide, so every role's `/readyz` — web, sync, worker — answers in the declared mode.
  const health = await loadHealthConfig(options.root);
  if (health?.readiness !== undefined) configureLifecycle({ readiness: health.readiness });
  const replicaOverride = replicaOverrides(options.runtime, runtime.services.db, options.env);
  const running = await startRoles({
    roles: [role],
    port,
    metricsPort,
    metrics,
    buildId,
    runtime,
    routes: web?.routes ?? [],
    env: options.env,
    // The three facts only a process serving documents has (`WebSurface`); `startWeb` is their
    // one reader, so every other role hands none.
    ...(web === undefined
      ? {}
      : {
          signInPath: web.signInPath,
          inlineStyles: web.inlineStyles,
          inlineScripts: web.inlineScripts,
        }),
    // The app's own `apps/web/site/errors/<status>.html`, resolved inside `startWeb` so this
    // process and `x dev` cannot answer a browser differently.
    root: options.root,
    http: containerBinding(options.env, options.hostname),
    // `app.config.ts`'s drain section: the readiness grace the chart's grace period is sized for.
    ...(drain === undefined ? {} : { drain }),
    // The read-replica scope rides in FRONT of whatever the host supplied, or the host's own value
    // passes through untouched. `DATABASE_REPLICA_URL` was read by no booted process before this:
    // `defaultClient()` is the one composer of a replicated pair and it runs only when an app
    // installed no client, which no framework boot leaves true (`runtime-queue.ts`).
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
