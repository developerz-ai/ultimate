// `x dev` — the app, booted. Every role in one Bun process, embedded Postgres/events/storage
// started for real, the app's own modules loaded into the framework's registries, and the route
// table those registries hold served over HTTP. `/_x` rides along so an agent can introspect the
// running app. No Docker, no env setup: an unset variable means the embedded default.

import { watch } from 'node:fs';
import { join } from 'node:path';
import { listActions, toRoute } from '@ultimat3/action';
import type { Role } from '@ultimat3/core';
import type { Route } from '@ultimat3/http';
import { json as jsonResponse } from '@ultimat3/http';
import type { Manifest } from '@ultimat3/manifest';
import { MANIFEST_FILENAME } from '@ultimat3/manifest';
import { checkAppBoundaries } from './app-boundaries';
import { loadApp } from './app-load';
import { appManifest } from './app-manifest';
import { requireAppRoot } from './app-root';
import type { CliCommand, CommandContext } from './command';
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
  stop(): Promise<void>;
}

interface DevState {
  manifest: Manifest;
  reloads: number;
}

/**
 * `/_x` is the agent's introspection surface: the same facts as `x.manifest.json`, plus the live
 * boundary report, plus the reload counter a test can poll instead of sleeping. Public, because
 * it exists to be read without credentials by whatever is driving the dev loop.
 */
function devRoutes(root: string, state: DevState, server: () => DevServer): readonly Route[] {
  const routes: Record<string, () => unknown | Promise<unknown>> = {
    '/_x': () => ({
      ok: true,
      endpoints: ['/_x/manifest', '/_x/routes', '/_x/boundaries', '/_x/services'],
    }),
    '/_x/manifest': () => state.manifest,
    '/_x/routes': () => ({ routes: state.manifest.routes }),
    '/_x/boundaries': async () => ({ findings: await checkAppBoundaries(root) }),
    '/_x/services': () => ({
      services: server().services,
      roles: server().roles,
      findings: server().findings,
      reloads: state.reloads,
    }),
  };
  return Object.entries(routes).map(([path, body]) => ({
    method: 'GET' as const,
    path,
    meta: { name: `dev${path.replaceAll('/', '.')}`, auth: 'public' as const, tags: ['_x'] },
    handler: async (): Promise<Response> => jsonResponse(await body()),
  }));
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
  const routes: readonly Route[] = [
    ...devRoutes(options.root, state, () => server),
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
      },
      lines: [
        msg('cli.dev.roles', { roles: server.roles.join(', ') }),
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
