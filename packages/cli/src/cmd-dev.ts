// `x dev` — every role in one Bun process with the role boundary still enforced, embedded
// Postgres/events/storage, and `/_x` mounted so an agent can introspect the running app over
// HTTP. No Docker, no env setup: an unset variable means the embedded default.

import { watch } from 'node:fs';
import { join } from 'node:path';
import { requireAppRoot } from './app-root';
import type { CliCommand, CommandContext } from './command';
import type { DevServices } from './dev-services';
import { describeServices, ROLES, resolveServices } from './dev-services';
import type { AppManifest } from './manifest-scan';
import { scanApp } from './manifest-scan';
import { msg } from './messages';
import type { CommandResult } from './output';
import { flagString } from './parse';
import { checkAppBoundaries } from './surfaces';

const DEFAULT_PORT = 3000;

export interface DevServer {
  readonly url: string;
  readonly services: DevServices;
  stop(): Promise<void>;
}

interface DevState {
  manifest: AppManifest;
  reloads: number;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

/**
 * `/_x` is the agent's introspection surface: the same facts as `x.manifest.json`, plus the live
 * boundary report, plus the reload counter a test can poll instead of sleeping.
 */
function devRoutes(root: string, state: DevState, services: DevServices) {
  return {
    '/_x': () =>
      json({
        ok: true,
        endpoints: ['/_x/manifest', '/_x/routes', '/_x/boundaries', '/_x/services'],
      }),
    '/_x/manifest': () => json(state.manifest),
    '/_x/routes': () =>
      json({
        routes: state.manifest.entries
          .filter((entry) => entry.kind === 'route')
          .map((entry) => ({ path: entry.path, surface: entry.surface, meta: entry.meta })),
      }),
    '/_x/boundaries': async () => json({ findings: await checkAppBoundaries(root) }),
    '/_x/services': () => json({ services, reloads: state.reloads }),
    '/healthz': () => new Response('ok'),
    '/readyz': () => new Response('ok'),
  };
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
  readonly onReload?: (file: string, durationMs: number) => void;
}

export async function startDev(options: StartDevOptions): Promise<DevServer> {
  const services = resolveServices(options.root, options.env);
  const state: DevState = { manifest: await scanApp({ root: options.root }), reloads: 0 };
  const routes = devRoutes(options.root, state, services);
  const server = Bun.serve({
    port: options.port,
    routes,
    fetch: () => new Response('not found', { status: 404 }),
  });
  const stopWatching = watchApp(options.root, (file) => {
    const started = performance.now();
    void scanApp({ root: options.root }).then((manifest) => {
      state.manifest = manifest;
      state.reloads += 1;
      options.onReload?.(file, Math.round(performance.now() - started));
    });
  });
  return {
    url: `http://localhost:${server.port}`,
    services,
    async stop() {
      stopWatching();
      await server.stop(true);
    },
  };
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
        summary: `roles to run (default: all of ${ROLES.join(',')})`,
      },
      { name: 'once', type: 'boolean', summary: 'boot, report, exit — for smoke tests and CI' },
    ],
  },
  async run(ctx: CommandContext): Promise<CommandResult> {
    const root = requireAppRoot('dev', ctx.cwd).dir;
    const port = Number.parseInt(flagString(ctx.args, 'port') ?? String(DEFAULT_PORT), 10);
    const server = await startDev({
      root,
      port,
      env: ctx.env,
      onReload: (file, durationMs) => {
        if (!ctx.args.json)
          process.stdout.write(`${msg('cli.dev.hmr', { file, ms: durationMs })}\n`);
      },
    });
    const summary = msg('cli.dev.ready', {
      url: server.url,
      services: describeServices(server.services),
    });
    const result: CommandResult = {
      ok: true,
      command: 'dev',
      summary,
      data: {
        url: server.url,
        stateDir: server.services.stateDir,
        db: server.services.db.url,
        events: server.services.events.url,
        storage: server.services.storage.url,
        introspect: `${server.url}/_x`,
      },
      lines: [`  manifest ${join(root, 'x.manifest.json')}`, `  introspect ${server.url}/_x`],
    };
    if (ctx.args.flags.get('once') === true) {
      await server.stop();
      return result;
    }
    // Long-running: the process stays alive on the server handle until SIGINT.
    return result;
  },
};
