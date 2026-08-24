// `x dev` — the app, booted. Every role in one Bun process, embedded Postgres/events/storage
// started for real, the app's own modules loaded into the framework's registries, and the route
// table those registries hold served over HTTP. `@ultimat3/admin`'s `/_x` dashboard is mounted
// alongside it — mounted, never re-implemented — so an agent can introspect the running app.
// No Docker, no env setup: an unset variable means the embedded default.

import { watch } from 'node:fs';
import { join } from 'node:path';
import { devShellStyle } from '@ultimat3/admin/dev';
import type { Role } from '@ultimat3/core';
import { configureTelemetry, METRICS_PATH, noopExporter } from '@ultimat3/core';
import { setStatementObserver } from '@ultimat3/db';
import type { OverlayNotice, RequestContext, Route } from '@ultimat3/http';
import { asCtx } from '@ultimat3/http';
import type { Manifest } from '@ultimat3/manifest';
import { MANIFEST_FILENAME } from '@ultimat3/manifest';
import { apiRoutes } from './api-routes';
import { loadSignInPath } from './app-auth';
import { loadApp } from './app-load';
import { appManifest } from './app-manifest';
import { requireAppRoot } from './app-root';
import type { CliCommand, CommandContext } from './command';
import { assetRoutes } from './dev-assets';
import type { DevDashboardInput, DevStatus } from './dev-dashboard';
import { devDashboardRoutes, devPanels } from './dev-dashboard';
import { clearLock, preflight, writeLock } from './dev-lock';
import { createStatementLedger } from './dev-n-plus-one';
import { appRoutes } from './dev-render';
import { replicaOverrides } from './dev-replica';
import type { RunningRoles } from './dev-roles';
import { DEV_BINDING, DEV_ROLES, selectRoles, startRoles } from './dev-roles';
import type { RunningServices } from './dev-runtime';
import { cdnLabel, describeCdn, describeMail, mailLabel, startServices } from './dev-runtime';
import type { DevServices } from './dev-services';
import { describeServices, reportedUrls, resolveServices } from './dev-services';
import { storageRoutes } from './dev-storage';
import { createTraceRecorder } from './dev-traces';
import { intFlagOr, PORT_RANGE } from './flag-number';
import { holdUntilShutdown } from './hold';
import type { IslandBundle } from './island-bundle';
import { buildIslands } from './island-bundle';
import { islandHarnessRoutes } from './island-harness-route';
import { islandRoutes } from './island-routes';
import { loadIslandStates } from './island-states-load';
import { msg } from './messages';
import type { CommandResult, Finding } from './output';
import { findingFrom } from './output';
import { flagString } from './parse';
import { metricsPortFor } from './serve';
import { loopFacts, loopFinding, loopNotice } from './statement-loop';

const DEFAULT_PORT = 3000;

export interface DevServer {
  readonly url: string;
  readonly services: DevServices;
  readonly roles: readonly Role[];
  /** The manifest as it stands now — a reload that registers a new route moves it. */
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
  stop(): Promise<void>;
}

interface DevState {
  manifest: Manifest;
  reloads: number;
  /** A save that will not build. Replaced on every attempt, so a fixed file clears it. */
  reloadFinding: Finding | undefined;
  /**
   * The client entries, rebuilt on the same tick as the manifest. An island is the one module this
   * process never imports, so a fresh `Bun.build` is the whole of its reload — no module cache to
   * invalidate, which is exactly why editing one takes effect where editing a route does not.
   */
  islands: IslandBundle;
}

/** Debounced: a save that touches five files is one reload, not five. */
function watchApp(root: string, onChange: (file: string) => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last = '';
  const watcher = watch(root, { recursive: true }, (_event, filename) => {
    if (filename === null || filename.includes('.x/') || filename.includes('node_modules')) return;
    last = filename;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => onChange(last), 30);
  });
  return () => {
    if (timer !== undefined) clearTimeout(timer);
    watcher.close();
  };
}

export interface StartDevOptions {
  readonly root: string;
  readonly port: number;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly roles?: readonly Role[];
  readonly onReload?: (file: string, durationMs: number) => void;
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
  const services = resolveServices(options.root, options.env);
  const runtime: RunningServices = await startServices(services, options.env);
  // Installed before the app loads, so a span opened during registration is already recorded.
  // Tracing is always on in the framework and free until an exporter is configured; `x dev` is
  // what configures one, which is the whole reason `/_x/timeline` has anything to draw.
  const traces = createTraceRecorder();
  configureTelemetry({ exporter: traces.exporter });
  // Installed at the same moment and for the same reason: an observer is the single switch that
  // turns statement instrumentation on at all (`@ultimat3/db`'s `observe.ts`), so the timeline's
  // SQL rows and the repeat counts arrive together rather than through two toggles. `serve.ts`
  // installs neither — a production process pays the one `undefined` branch the seam costs
  // uninstalled, and nothing more (axiom 6).
  const statements = createStatementLedger();
  setStatementObserver(statements.observer);
  const app = await loadApp(options.root);
  const state: DevState = {
    manifest: (await appManifest(options.root)).manifest,
    reloads: 0,
    reloadFinding: undefined,
    islands: await buildIslands(options.root),
  };
  // The manifest's build id is a content hash of every fact below it, so a dev document's
  // `x-ultimate-build` header names the exact shape the client was served against. Pinned at
  // boot on purpose: the header is handed to the HTTP config and the render modes once, and a
  // reload cannot re-pin it — `state.manifest.buildId` is what `/_x` and `--json` report, so a
  // divergence between the two is visible rather than silent, and a restart closes it.
  const buildId = state.manifest.buildId;

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

  const routes: readonly Route[] = [
    ...devDashboardRoutes(dashboard),
    // The same API table the container serves: a read that answers here and 404s in production
    // is exactly the drift one composition exists to prevent.
    ...apiRoutes(),
    // The image pipeline's only HTTP surface: the icons the web manifest declares, and the
    // variants every `srcset` promises. Mounted before the app's own routes so a page route can
    // never shadow `/icons` or `/media`.
    ...assetRoutes({ root: options.root, storage: runtime.storage }),
    ...storageRoutes({ storage: runtime.storage }),
    // The chunks the documents below name. Mounted before the app's routes for the reason
    // `/icons` and `/media` are: a page route must not be able to shadow an asset URL.
    ...islandRoutes(() => state.islands),
    // `x shot --island`'s harness, in the `/_x` dev namespace so no app route can shadow it. It
    // lives here rather than in a second server because everything it needs is in THIS process:
    // the built chunks, the app's stylesheet registry, and the one embedded Postgres a checkout
    // may have. The states are read per REQUEST — an author editing a state and re-running the
    // command must not need a restart to see it.
    ...islandHarnessRoutes({
      islands: () => state.islands,
      states: () => loadIslandStates(options.root),
    }),
    ...appRoutes({ buildId, resolveIsland: (file) => state.islands.resolverFor(file) }),
  ];

  const replicaOverride = replicaOverrides(undefined, services.db, options.env);
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
    // Read from `app.config.ts` rather than threaded through `DevOptions`: it is the app's own
    // declaration, and `x dev` and `serve.ts` must not be able to disagree about where the app's
    // sign-in page is.
    signInPath: await loadSignInPath(options.root),
    // The same seam `serve.ts` passes: the app's own error page is a FILE, so the root is what
    // `startWeb` needs to find one.
    root: options.root,
    // The one document this process serves that the app did not write; `startRoles` covers the
    // app's own surfaces itself. `x dev` sends the policy report-only, so an uncovered `<style>`
    // here is a console report rather than a blank page — which is how this reached production.
    inlineStyles: [await devShellStyle()],
    // The fourth surface, and the only one an author sees without leaving the page they broke:
    // the overlay renders this request's own loops under the error it is already showing.
    // `serve.ts` boots through the same `startRoles` and passes nothing, so production has no
    // diagnostic to call.
    devNotices: (ctx: RequestContext): readonly OverlayNotice[] =>
      statements.repeatsFor(asCtx(ctx)).map(loopFacts).map(loopNotice),
    // The read-replica scope, opened per request. Absent for every app that names no
    // `DATABASE_REPLICA_URL` — which is every embedded boot by construction, since PGlite has no
    // standby — so this key does not exist on a homework app's boot at all.
    ...(replicaOverride === undefined ? {} : { overrides: replicaOverride }),
  });

  const stopWatching = watchApp(options.root, (file) => {
    const started = performance.now();
    void Promise.all([appManifest(options.root), buildIslands(options.root)])
      .then(([{ manifest }, islands]) => {
        state.manifest = manifest;
        state.islands = islands;
        state.reloads += 1;
        state.reloadFinding = undefined;
        options.onReload?.(file, Math.round(performance.now() - started));
      })
      // Same rule as a module that will not import: a save the manifest cannot be rebuilt from is
      // a finding on `/_x`, never an unhandled rejection that takes the dev server down.
      .catch((error: unknown) => {
        state.reloadFinding = { ...findingFrom(error), at: file };
      });
  });

  server = {
    url: running.url ?? `http://localhost:${options.port}`,
    services,
    roles: running.roles,
    get buildId(): string {
      return state.manifest.buildId;
    },
    // A getter, not a snapshot: `/_x` and `--json` must show the reload that just failed and the
    // loop the last request tripped, not the findings as they were when the route table was built.
    // The loops come last and carry their request id, so a boot report reads as a boot report and
    // a diagnostic that arrived a minute later reads as one too.
    get findings(): readonly Finding[] {
      const loops = statements.repeats().map(loopFacts).map(loopFinding);
      return state.reloadFinding === undefined
        ? [...app.findings, ...loops]
        : [...app.findings, state.reloadFinding, ...loops];
    },
    running,
    runtime,
    panels,
    async stop() {
      stopWatching();
      await running.stop();
      await runtime.stop();
      // Released after the roles: a span opened by an in-flight request still has an exporter to
      // end into. `configureTelemetry` merges, so handing back the noop is how it is uninstalled —
      // leaving it in place would keep every span of the next `startDev` in this process's buffer.
      configureTelemetry({ exporter: noopExporter });
      traces.reset();
      // Released with the exporter, after the roles, for the same reason: a statement still in
      // flight is observed by the ledger that counted the rest of its request. Leaving it
      // installed would keep every statement of the next `startDev` in this process's counts —
      // and, worse, keep instrumentation on in a process that is no longer a dev server.
      setStatementObserver(undefined);
      statements.reset();
    },
  };
  return server;
}

export const devCommand: CliCommand = {
  spec: {
    name: 'dev',
    summary: 'all roles in one process: embedded services, sub-second reload, /_x mounted',
    usage: 'x dev [--port 3000] [--role web,worker] [--once] [--json]',
    requiresApp: true,
    flags: [
      { name: 'port', type: 'string', summary: 'HTTP port', default: String(DEFAULT_PORT) },
      {
        name: 'role',
        type: 'string',
        // `replicator` is named because it is selectable and NOT default — it takes a replication
        // slot on a shared database, which is not something every `x dev` should do by starting.
        summary: `roles to run (default: all of ${DEV_ROLES.join(',')}; replicator is opt-in)`,
      },
      { name: 'once', type: 'boolean', summary: 'boot, report, exit — for smoke tests and CI' },
    ],
  },
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('dev', ctx.cwd).dir;
    // Validated, not `parseInt`'d: `x dev --port abc` handed `NaN` to `Bun.serve`, which binds an
    // arbitrary port — a dev server reachable at an address nothing printed.
    const port = intFlagOr(
      ctx.args,
      { name: 'port', command: 'dev', ...PORT_RANGE, example: `x dev --port ${DEFAULT_PORT}` },
      DEFAULT_PORT,
    );
    const roles = selectRoles(flagString(ctx.args, 'role'));
    // BEFORE anything boots. Both failures this catches were reachable and both reported the wrong
    // thing: a taken port surfaced as X_CLI_UNEXPECTED wrapping "Is port 3000 in use?" with a `fix:`
    // naming `x doctor`, and a second `x dev` on one checkout died later on X_DB_UNAVAILABLE whose
    // `fix:` named `x dev`. Neither is discoverable from the message; both are trivial once the
    // preflight has the state directory and the port in front of it.
    const services = resolveServices(root, ctx.env);
    const { clearedStale, release } = await preflight({
      stateDir: services.stateDir,
      port,
      // The address the web role will actually bind, never a wider one: probing `0.0.0.0` would
      // refuse a boot that a neighbour on one LAN interface does not actually block.
      hostname: DEV_BINDING.hostname,
      embeddedDb: services.db.mode === 'embedded',
    });
    // The directory is CLAIMED from here down, so a boot that throws has to give it back — the
    // `releaseBoot` shape, with one acquisition. Without it the first failed `x dev` in a shell
    // refuses every later one with a pid that is no longer running.
    const server = await startDev({
      root,
      port,
      roles,
      env: ctx.env,
      onReload: (file, durationMs) => {
        if (!ctx.args.json)
          process.stdout.write(`${msg('cli.dev.hmr', { file, ms: durationMs })}\n`);
      },
    }).catch((error: unknown) => {
      release();
      throw error;
    });
    const result: CommandResult = {
      ok: server.findings.length === 0,
      command: 'dev',
      summary: msg('cli.dev.ready', {
        url: server.url,
        panels: server.panels.length,
        // Rendered text, so the mail and CDN halves come from the catalog; `data` below carries the
        // status values a script parses, which is why the two are different calls and not one.
        services: `${describeServices(server.services)} ${mailLabel(server.runtime)} ${cdnLabel(server.runtime)}`,
      }),
      findings: server.findings,
      // Every fact `lines` prints is a fact `--json` carries, `manifest` included — or the two
      // renderers have drifted and only one of them can be scripted against.
      data: {
        url: server.url,
        roles: [...server.roles],
        sync: server.running.syncUrl,
        // The scrape target, on its own port for every role: what an operator points a Prometheus
        // at, and the one url here that must NOT be behind the ingress the app's own url is.
        metrics: `${server.running.metricsUrl}${METRICS_PATH}`,
        stateDir: server.services.stateDir,
        // Redacted, for the reason the mail and cdn lines below already give and this line did
        // not: `DATABASE_URL`, `NATS_URL` and `S3_ENDPOINT` all carry a password, and this object
        // is printed, logged and scraped. `reportedUrls` is the one projection that may be shown.
        ...reportedUrls(server.services),
        // The selecting env key, never the credential behind it: `SMTP_URL` carries a password
        // and this line is printed, logged and scraped.
        mail: describeMail(server.runtime),
        cdn: describeCdn(server.runtime),
        // The slot this process holds, or null when the replicator was not selected. Two of these
        // on one database is the one topology mistake that cannot be seen from the outside, so the
        // slot is a scriptable fact rather than a line in a log.
        replicationSlot: server.running.replicator?.slot ?? null,
        buildId: server.buildId,
        manifest: join(root, MANIFEST_FILENAME),
        introspect: `${server.url}/_x`,
        panels: [...server.panels],
      },
      lines: [
        // A hard kill leaves the lock behind; clearing it is normal and worth one line, never a
        // finding. First, because it happened before anything else this run reports.
        ...(clearedStale ? [msg('cli.dev.staleLock')] : []),
        msg('cli.dev.roles', { roles: server.roles.join(', ') }),
        msg('cli.dev.panels', { panels: server.panels.join(', ') }),
        msg('cli.dev.manifest', { path: join(root, MANIFEST_FILENAME) }),
        msg('cli.dev.introspect', { url: `${server.url}/_x` }),
      ],
    };
    await writeLock(services.stateDir, {
      pid: process.pid,
      port,
      url: server.url,
      startedAt: new Date().toISOString(),
    });
    if (ctx.args.flags.get('once') === true) {
      clearLock(services.stateDir);
      await server.stop();
      return result;
    }
    // Long-running: `dispatch` awaits this instead of exiting, so the watcher keeps reloading and
    // `/_x` stays reachable. Ctrl-C drains the web role through core's phases first and releases
    // the embedded Postgres, the worker and the watcher after — a hard kill leaves the PGlite
    // directory locked by a process that no longer exists.
    return {
      ...result,
      hold: holdUntilShutdown('dev', async () => {
        // The lock first: a stop() that throws must not leave a file claiming this pid still owns
        // the directory, because the next boot would then refuse for a process that is gone.
        clearLock(services.stateDir);
        await server.stop();
      }),
    };
  },
};
