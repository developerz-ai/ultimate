// `x dev` — the app, booted. Every role in one Bun process, embedded Postgres/events/storage
// started for real, the app's own modules loaded into the framework's registries, and the route
// table those registries hold served over HTTP. `@ultimat3/admin`'s `/_x` dashboard is mounted
// alongside it — mounted, never re-implemented — so an agent can introspect the running app.
// No Docker, no env setup: an unset variable means the embedded default.

import { watch } from 'node:fs';
import { join } from 'node:path';
import { listActions, toRoute } from '@ultimat3/action';
import type { Role } from '@ultimat3/core';
import type { Route } from '@ultimat3/http';
import type { Manifest } from '@ultimat3/manifest';
import { MANIFEST_FILENAME } from '@ultimat3/manifest';
import { loadApp } from './app-load';
import { appManifest } from './app-manifest';
import { requireAppRoot } from './app-root';
import type { CliCommand, CommandContext } from './command';
import type { DevDashboardInput, DevStatus } from './dev-dashboard';
import { devDashboardRoutes, devPanels } from './dev-dashboard';
import { appRoutes } from './dev-render';
import type { RunningRoles } from './dev-roles';
import { DEV_ROLES, selectRoles, startRoles } from './dev-roles';
import type { RunningServices } from './dev-runtime';
import { startServices } from './dev-runtime';
import type { DevServices } from './dev-services';
import { describeServices, resolveServices } from './dev-services';
import { msg } from './messages';
import type { CommandResult, Finding } from './output';
import { flagString } from './parse';

const DEFAULT_PORT = 3000;

export interface DevServer {
  readonly url: string;
  readonly services: DevServices;
  readonly roles: readonly Role[];
  /** Modules that would not import, and primitives that would not register. */
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
  const runtime: RunningServices = await startServices(services);
  const app = await loadApp(options.root);
  const state: DevState = { manifest: (await appManifest(options.root)).manifest, reloads: 0 };
  // The manifest's build id is a content hash of every fact below it, so a dev document's
  // `x-ultimate-build` header names the exact shape the client was served against.
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
    ...envOf(options.env),
  };
  const panels = devPanels(dashboard).map((panel) => panel.key);

  const routes: readonly Route[] = [
    ...devDashboardRoutes(dashboard),
    ...listActions().map(toRoute),
    ...appRoutes({ buildId }),
  ];

  const running = await startRoles({
    roles: options.roles ?? DEV_ROLES,
    port: options.port,
    buildId,
    runtime,
    routes,
  });

  const stopWatching = watchApp(options.root, (file) => {
    const started = performance.now();
    void appManifest(options.root).then(({ manifest }) => {
      state.manifest = manifest;
      state.reloads += 1;
      options.onReload?.(file, Math.round(performance.now() - started));
    });
  });

  server = {
    url: running.url ?? `http://localhost:${options.port}`,
    services,
    roles: running.roles,
    findings: app.findings,
    running,
    runtime,
    panels,
    async stop() {
      stopWatching();
      await running.stop();
      await runtime.stop();
    },
  };
  return server;
}

export const devCommand: CliCommand = {
  spec: {
    name: 'dev',
    summary: 'all roles in one process: embedded services, sub-second reload, /_x mounted',
    usage: 'x dev [--port 3000] [--role web,worker] [--json]',
    requiresApp: true,
    flags: [
      { name: 'port', type: 'string', summary: 'HTTP port', default: String(DEFAULT_PORT) },
      {
        name: 'role',
        type: 'string',
        summary: `roles to run (default: all of ${DEV_ROLES.join(',')})`,
      },
      { name: 'once', type: 'boolean', summary: 'boot, report, exit — for smoke tests and CI' },
    ],
  },
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('dev', ctx.cwd).dir;
    const port = Number.parseInt(flagString(ctx.args, 'port') ?? String(DEFAULT_PORT), 10);
    const roles = selectRoles(flagString(ctx.args, 'role'));
    const server = await startDev({
      root,
      port,
      roles,
      env: ctx.env,
      onReload: (file, durationMs) => {
        if (!ctx.args.json)
          process.stdout.write(`${msg('cli.dev.hmr', { file, ms: durationMs })}\n`);
      },
    });
    const result: CommandResult = {
      ok: server.findings.length === 0,
      command: 'dev',
      summary: msg('cli.dev.ready', {
        url: server.url,
        panels: server.panels.length,
        services: describeServices(server.services),
      }),
      findings: server.findings,
      data: {
        url: server.url,
        roles: [...server.roles],
        sync: server.running.syncUrl,
        stateDir: server.services.stateDir,
        db: server.services.db.url,
        events: server.services.events.url,
        storage: server.services.storage.url,
        introspect: `${server.url}/_x`,
        panels: [...server.panels],
      },
      lines: [
        msg('cli.dev.roles', { roles: server.roles.join(', ') }),
        msg('cli.dev.panels', { panels: server.panels.join(', ') }),
        `  manifest ${join(root, MANIFEST_FILENAME)}`,
        `  introspect ${server.url}/_x`,
      ],
    };
    if (ctx.args.flags.get('once') === true) {
      await server.stop();
      return result;
    }
    // Long-running: the process stays alive on the server handle until SIGINT.
    return result;
  },
};
