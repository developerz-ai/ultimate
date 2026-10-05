// `x dev`'s boot: every role in one Bun process, embedded Postgres/events/storage started for real,
// the app's own modules loaded into the framework's registries, the route table they hold served
// over HTTP with `/_x` beside it, and the watcher that rebuilds on save (`dev-rebuild.ts`). The
// command that prints it and holds the process is `cmd-dev.ts`.

import { devShellStyle } from '@ultimat3/admin/dev';
import type { Role } from '@ultimat3/core';
import { configureTelemetry, noopExporter } from '@ultimat3/core';
import { setStatementObserver } from '@ultimat3/db';
import type { OverlayNotice, RequestContext } from '@ultimat3/http';
import { asCtx } from '@ultimat3/http';
import { loadSignInPath } from './app-auth';
import { appManifest } from './app-manifest';
import type { StalePin } from './app-reload-graph';
import { enableReloadTracking } from './app-reload-graph';
import { loadAppRuntime } from './app-runtime';
import type { DevDashboardInput, DevStatus } from './dev-dashboard';
import { devPanels } from './dev-dashboard';
import { declareDevEnvironment, needsDevEnvironmentDeclaration } from './dev-environment';
import { createStatementLedger } from './dev-n-plus-one';
import type { DevState } from './dev-rebuild';
import { devRebuilder } from './dev-rebuild';
import { devRouteTable } from './dev-route-table';
import { createTraceRecorder } from './dev-traces';
import { watchTree } from './dev-watch-tree';
import { buildIslands } from './island-bundle';
import { FRAME_STYLE } from './island-harness';
import type { Finding } from './output';
import type { RunningRoles } from './role-start';
import { DEV_ROLES, startRoles } from './role-start';
import type { DevServices } from './runtime-bindings';
import { resolveServices, withRealtimeEvents } from './runtime-bindings';
import { attachedIsr } from './runtime-isr';
import type { RuntimeOverrides } from './runtime-overrides';
import { replicaOverrides } from './runtime-replica';
import type { RunningServices } from './runtime-services';
import { releaseOrThrow, startServices } from './runtime-services';
import { metricsPortFor, releaseBoot } from './serve';
import { loopFacts, loopFinding, loopNotice } from './statement-loop';

export interface DevServer {
  readonly url: string;
  readonly services: DevServices;
  readonly roles: readonly Role[];
  /**
   * `BUILD_ID` when stamped — the id every response carries. Otherwise the manifest as it stands
   * now, so a reload that registers a new route moves it.
   */
  readonly buildId: string;
  /**
   * Modules that would not import, primitives that would not register, reloads that would not
   * build — and the statement loops this process has counted so far, which is what puts an N+1 in
   * `x dev`'s own output and in `--json` without a channel of its own.
   */
  readonly findings: readonly Finding[];
  readonly running: RunningRoles;
  readonly runtime: RunningServices;
  /** Panel keys `/_x` mounted, in tab order. Reported so `--json` names what is reachable. */
  readonly panels: readonly string[];
  /** `POST <path>` of the app's default MCP endpoint, or `null` when nothing was mounted. */
  readonly mcp: string | null;
  /** `POST <path>` of every mounted MCP endpoint, default first — `[]` when none was. */
  readonly mcpPaths: readonly string[];
  stop(): Promise<void>;
}

export interface StartDevOptions {
  readonly root: string;
  readonly port: number;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly roles?: readonly Role[];
  readonly onReload?: (file: string, durationMs: number) => void;
  /**
   * A save reached a module that defines a primitive, so this process cannot serve it
   * (`takeStalePins`). Given, it is called INSTEAD of `onReload` — `x dev`'s child drains and exits
   * for its supervisor to boot a fresh one. Absent, the save is `X_DEV_RESTART_REQUIRED` on `/_x`.
   */
  readonly onRestart?: (pins: readonly StalePin[]) => void;
}

/**
 * The environment `devDashboard` refuses to mount in. Spread conditionally rather than passed as
 * `undefined`: `exactOptionalPropertyTypes` makes "absent" and "explicitly undefined" different
 * answers, and only the absent one lets the dashboard read the process environment itself.
 */
const envOf = (env: StartDevOptions['env']): { env?: string } => {
  const value = env['NODE_ENV'] ?? env['X_ENV'];
  return value === undefined ? {} : { env: value };
};

/**
 * Boot order is the production order: services first, then the app's modules (importing them IS
 * the registration), then the roles that serve what those modules registered. A module that
 * fails to import becomes a finding rather than a dead process — the point of the dev loop is to
 * still be reachable while something is broken.
 */
export async function startDev(options: StartDevOptions): Promise<DevServer> {
  // EVERY boot: a scratch server (`x shot`, `ui.shot`) boots here too, and without this a
  // fail-closed dev actor installs nothing — the picture is of a 401. Idempotent.
  declareDevEnvironment(options.env);
  // Before the first scan: the watcher's rescans evict a saved module AND everything importing it,
  // and that needs the import graph recorded as each module is first loaded (`app-reload-graph.ts`).
  enableReloadTracking(true);
  // The declaration lands on `process.env`; the env this boot passes on must carry it too, or every
  // service resolved from `options.env` still reads no `ULTIMATE_ENV`.
  const env = needsDevEnvironmentDeclaration(options.env)
    ? { ...options.env, ULTIMATE_ENV: 'development' }
    : options.env;
  const resolved = resolveServices(options.root, env);
  // The app's `apps/<app>/runtime.ts`, read ONCE and handed to `startServices` exactly as
  // `serve.ts`'s `withAppRuntime` does — so the disks (`storage`), the queue, the mail driver and
  // every other override a deployment declares are the ones development runs too. Until 22.4 this
  // boot passed nothing here and built its own embedded disk, so an app's `/_storage` routes and its
  // actions wrote to two different places in `x dev` and to one in production.
  const appRuntime = await loadAppRuntime(options.root);
  const runtime: RunningServices = await startServices(resolved, env, appRuntime);
  // The events binding the boot line reports is the bus the runtime chose, read off it.
  const services = withRealtimeEvents(resolved, env, runtime.realtime);
  // `serve.ts`'s `releaseBoot` shape: everything acquired from here on is released, newest first,
  // if the boot throws — a failed `x dev` left PGlite holding `.x/pgdata` for the retry to meet.
  const acquired: (() => void | Promise<void>)[] = [() => runtime.stop()];
  try {
    return await bootDev(options, services, runtime, acquired, appRuntime);
  } catch (error) {
    await releaseBoot(acquired);
    throw error;
  }
}

async function bootDev(
  options: StartDevOptions,
  services: ReturnType<typeof resolveServices>,
  runtime: RunningServices,
  acquired: (() => void | Promise<void>)[],
  appRuntime: RuntimeOverrides | undefined,
): Promise<DevServer> {
  // Installed before the app loads, so a span opened during registration is already recorded.
  // Tracing is always on in the framework and free until an exporter is configured; `x dev` is
  // what configures one, which is the whole reason `/_x/timeline` has anything to draw.
  const traces = createTraceRecorder();
  configureTelemetry({ exporter: traces.exporter });
  acquired.push(() => {
    configureTelemetry({ exporter: noopExporter });
    traces.reset();
  });
  // Installed at the same moment and for the same reason: an observer is the single switch that
  // turns statement instrumentation on at all (`@ultimat3/db`'s `observe.ts`), so the timeline's
  // SQL rows and the repeat counts arrive together rather than through two toggles. `serve.ts`
  // installs neither — a production process pays the one `undefined` branch the seam costs
  // uninstalled, and nothing more (axiom 6).
  const statements = createStatementLedger();
  setStatementObserver(statements.observer);
  acquired.push(() => {
    setStatementObserver(undefined);
    statements.reset();
  });
  // ONE load at boot, the same call the rebuild below makes: the manifest and the findings are
  // two projections of one scan. Until 2026-09-07 this was `loadApp` for the findings and then
  // `appManifest` — which loads again — for the manifest, so a save landing between the two put
  // `/_x`'s findings and its manifest on different registration states.
  const app = await appManifest(options.root);
  const state: DevState = {
    manifest: app.manifest,
    reloads: 0,
    reloadFinding: undefined,
    appFindings: app.findings,
    islands: await buildIslands(options.root),
  };
  // The manifest's build id is a content hash of every fact below it, so a dev document's
  // `x-ultimate-build` header names the exact shape the client was served against. Pinned at
  // boot on purpose: the header is handed to the HTTP config and the render modes once, and a
  // reload cannot re-pin it — `state.manifest.buildId` is what `/_x` and `--json` report, so a
  // divergence between the two is visible rather than silent, and a restart closes it.
  // `BUILD_ID` wins when set — `serve.ts`'s rule, so an e2e `deploy.newBuild()` can restart `x dev`
  // as a new build with the same sources.
  // Stamped, it is ALSO what `server.buildId` answers below: the process serves no other build.
  const rawStamp = options.env['BUILD_ID'];
  const stamped = rawStamp !== undefined && rawStamp !== '' ? rawStamp : undefined;
  const buildId = stamped ?? state.manifest.buildId;

  let server: DevServer;
  // Read at request time, never captured at boot: `/_x/services` must report the reload counter
  // and the findings as they are now, not as they were when the route table was built.
  const dashboard: DevDashboardInput = {
    root: options.root,
    runtime,
    status: (): DevStatus => ({
      url: server.url,
      services: server.services,
      roles: server.roles,
      findings: server.findings,
      reloads: state.reloads,
    }),
    traces,
    statements,
    ...envOf(options.env),
  };
  const panels = devPanels(dashboard).map((panel) => panel.key);

  // `x dev`'s own, so a reload can empty it (a save otherwise kept a page's first render for its
  // ttl); attached, so a tag bust reaches it too. Released with the roles.
  const { isr, release: releaseIsr } = attachedIsr({ buildId });
  acquired.push(releaseIsr);
  const { routes, theme, speculation, errorStyles, mcpPath, mcpPaths } = await devRouteTable({
    isr,
    root: options.root,
    env: options.env,
    buildId,
    storage: runtime.storage,
    dashboard,
    islands: () => state.islands,
    realtime: runtime.realtime,
    rateLimitStore: appRuntime?.rateLimitStore ?? runtime.rateLimitStore,
    appRoutes: appRuntime?.routes,
    images: appRuntime?.images,
  });

  // The app's `apps/<app>/runtime.ts`, composed exactly as `runRole` composes a caller's
  // `runtime`: the replica scope in front, the app's own middleware behind it. Before this the
  // first argument was `undefined` here and an app's middleware reached no development process.
  const replicaOverride = replicaOverrides(appRuntime, services.db, options.env);
  const running = await startRoles({
    roles: options.roles ?? DEV_ROLES,
    port: options.port,
    // `serve.ts`'s expression, called rather than restated: `METRICS_PORT` was read in the
    // container and ignored here, so the scrape port an operator moved was the one port `x dev`
    // could not move — and the second `x dev` on a box died binding the hardcoded 9090.
    metricsPort: metricsPortFor(options.env, options.port),
    buildId,
    runtime,
    routes,
    env: options.env,
    // Read from `app.config.ts` rather than threaded through `DevOptions`: `x dev` and `serve.ts`
    // must not be able to disagree about where the app's sign-in page is.
    signInPath: await loadSignInPath(options.root),
    // The same seam `serve.ts` passes: the app's own error page is a FILE under this root.
    root: options.root,
    // The `/_x` shell, the harness's frame, and the app's own error pages — the inline bodies this
    // process serves; the app's surfaces are content-hashed files `'self'` admits.
    inlineStyles: [await devShellStyle(), FRAME_STYLE, ...errorStyles],
    inlineScripts: [theme.cspSource, ...(speculation === undefined ? [] : [speculation.cspSource])],
    // The overlay renders this request's own loops under the error it is already showing.
    // `serve.ts` boots through the same `startRoles` and passes nothing (axiom 6).
    devNotices: (ctx: RequestContext): readonly OverlayNotice[] =>
      statements.repeatsFor(asCtx(ctx)).map(loopFacts).map(loopNotice),
    // The read-replica scope, opened per request. Absent for every app that names no
    // `DATABASE_REPLICA_URL` — which is every embedded boot by construction, since PGlite has no
    // standby — so this key does not exist on a homework app's boot at all.
    ...(replicaOverride === undefined ? {} : { overrides: replicaOverride }),
  });
  acquired.push(() => running.stop());

  const rebuild = devRebuilder(options, state, isr);
  // Watched one directory at a time, so an ignored one costs no descriptor at all — `dev-watch.ts`
  // decides which, from the app's own `.gitignore`. A recursive watch on the root registered one
  // inotify descriptor per directory in the tree, `.git/`, `node_modules/` and the `.x/` this
  // process writes to included, and filtered the events afterwards.
  const watcher = watchTree({ root: options.root, onChange: rebuild });

  server = {
    url: running.url ?? `http://localhost:${options.port}`,
    services,
    roles: running.roles,
    mcp: mcpPath,
    mcpPaths,
    get buildId(): string {
      return stamped ?? state.manifest.buildId;
    },
    // A getter, not a snapshot: `/_x` and `--json` must show the reload that just failed and the
    // loop the last request tripped, not the findings as they were when the route table was built.
    // The loops come last and carry their request id, so a boot report reads as a boot report and
    // a diagnostic that arrived a minute later reads as one too.
    get findings(): readonly Finding[] {
      const loops = statements.repeats().map(loopFacts).map(loopFinding);
      return state.reloadFinding === undefined
        ? [...state.appFindings, ...loops]
        : [...state.appFindings, state.reloadFinding, ...loops];
    },
    running,
    runtime,
    panels,
    // The boot's own unwind list IS the stop list — one list, so the two cannot drift — plus the
    // watcher. Every step runs and the first failure is rethrown (`releaseOrThrow`): one refused
    // role stop used to leave PGlite's lock held for the next `x dev`. Newest first: the watcher,
    // the roles, ISR, the statement ledger and the exporter (after the roles, so an in-flight
    // request still has both), then the services.
    stop: () => releaseOrThrow([...acquired, () => watcher.close()]),
  };
  return server;
}
