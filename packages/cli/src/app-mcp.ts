// The app's own MCP endpoint, mounted by the web role. `defineAppMcp` built `mcp.route` — a
// `POST` handler with token auth and per-class rate limits — and `app.config.ts` declared
// `ai: { mcp: { expose: true, path: '/mcp' } }` by DEFAULT, and nothing between the two served it:
// neither `x dev` nor `runRole` mounted the route, so `POST /mcp` answered `X_ROUTE_NOT_FOUND` in
// every app ever scaffolded (measured 2026-09-05). The contract is one file: `apps/<app>/mcp.ts`
// exports `mcp`, an `AppMcp`; this module finds it, and both boots mount what it carries.

// why: a directory's existence — `Bun.file().exists()` answers for files, and `apps/` is a directory.
import { existsSync } from 'node:fs';
// why: Bun exposes no path-join primitive; the config file and each candidate are joined to root.
import { join } from 'node:path';
import { logger } from '@ultimat3/core';
import type { Route } from '@ultimat3/http';
import { type AppMcp, McpAppUnmountedError } from '@ultimat3/mcp';
import { APP_CONFIG_EXPORT } from './app-auth';
import { APP_CONFIG_FILE } from './app-root';

/** The one file an app writes, per app directory. */
export const APP_MCP_GLOB = 'apps/*/mcp.ts';
/** The export that file makes — an `AppMcp`, the value `defineAppMcp` returns. */
export const APP_MCP_EXPORT = 'mcp';
/** What the boot line and `/_x` call the route. */
export const APP_MCP_ROUTE_NAME = 'mcp';

export interface AppMcpMount {
  /** `[]` when `expose` is false, when nothing exports `mcp`, or when the export has no route. */
  readonly routes: readonly Route[];
  /** `POST <path>` when mounted, else `null` — the boot line prints it. */
  readonly path: string | null;
  /** Set exactly when `expose` is true and `routes` is empty: the reason, as an instruction. */
  readonly warning: McpAppUnmountedError | undefined;
}

interface ExposeDeclaration {
  readonly expose: boolean;
  readonly path: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * `config.ai.mcp`, off the app's own resolved config — the exported `config` is what
 * `defineConfig` returned, so both keys are present and defaulted. Read the same way
 * `loadSignInPath` reads `auth.signInPath`: the config file is imported, never re-parsed.
 * An app with no config file has nothing exposed and nothing to warn about.
 */
async function exposeDeclaration(root: string): Promise<ExposeDeclaration | undefined> {
  const configPath = join(root, APP_CONFIG_FILE);
  if (!(await Bun.file(configPath).exists())) return undefined;
  const module = (await import(configPath)) as Record<string, unknown>;
  const config = module[APP_CONFIG_EXPORT];
  if (!isRecord(config) || !isRecord(config['ai']) || !isRecord(config['ai']['mcp'])) {
    return undefined;
  }
  const mcp = config['ai']['mcp'];
  const path = mcp['path'];
  return {
    expose: mcp['expose'] === true,
    path: typeof path === 'string' && path.startsWith('/') ? path : '/mcp',
  };
}

const isAppMcp = (value: unknown): value is AppMcp =>
  isRecord(value) && 'server' in value && 'tools' in value && 'route' in value;

/** Every `apps/<app>/mcp.ts`, app-root-relative and sorted, so two apps answer in one order. */
async function candidates(root: string): Promise<readonly string[]> {
  // A root with no `apps/` is an app with no MCP file, never a boot failure — the scan's ENOENT
  // is answered as "none", and the warning below says which file to write.
  if (!existsSync(join(root, 'apps'))) return [];
  const files: string[] = [];
  for await (const file of new Bun.Glob(APP_MCP_GLOB).scan({ cwd: root })) files.push(file);
  return files.sort();
}

/**
 * The route to mount, or the reason there is none. Pure over the filesystem it is pointed at;
 * `mountAppMcp` below is the one place the warning becomes a log line.
 *
 * `meta.auth: 'public'` and `enforcedBy: 'handler'` — the http pipeline must not pre-judge:
 * `mcp.route.handle` is the one evaluation, and it reads `Authorization: Bearer` through the
 * `resolveToken` the app gave `defineAppMcp`, then decides per tool through the same policy every
 * other surface evaluates. A pipeline `auth: 'required'` would demand a session cookie an agent
 * does not have and answer 401 before the token was ever read.
 */
export async function appMcpMount(root: string): Promise<AppMcpMount> {
  const declared = await exposeDeclaration(root);
  if (declared === undefined || !declared.expose)
    return { routes: [], path: null, warning: undefined };
  const files = await candidates(root);
  const fallbackFile = 'apps/web/mcp.ts';
  if (files.length === 0) {
    return {
      routes: [],
      path: null,
      warning: new McpAppUnmountedError({
        reason: 'missing',
        path: declared.path,
        file: fallbackFile,
      }),
    };
  }
  for (const file of files) {
    const module = (await import(join(root, file))) as Record<string, unknown>;
    const exported = module[APP_MCP_EXPORT];
    if (!isAppMcp(exported)) continue;
    const route = exported.route;
    if (route === undefined) {
      return {
        routes: [],
        path: null,
        warning: new McpAppUnmountedError({ reason: 'no-route', path: declared.path, file }),
      };
    }
    return {
      routes: [
        {
          method: 'POST',
          path: declared.path,
          handler: (request) => route.handle(request.raw),
          meta: { name: APP_MCP_ROUTE_NAME, auth: 'public', enforcedBy: 'handler' },
        },
      ],
      path: declared.path,
      warning: undefined,
    };
  }
  return {
    routes: [],
    path: null,
    warning: new McpAppUnmountedError({
      reason: 'missing',
      path: declared.path,
      file: files[0] ?? fallbackFile,
    }),
  };
}

/**
 * The boot's call: the routes to spread into the table, with the warning already logged ONCE and
 * the mount announced. Both `x dev` and `runRole` go through here, so a developer's terminal and a
 * container's log say the same thing about the same endpoint.
 */
export async function mountAppMcp(root: string): Promise<AppMcpMount> {
  const mount = await appMcpMount(root);
  if (mount.warning !== undefined) {
    logger.warn(`${mount.warning.code}: ${mount.warning.cause} — fix: ${mount.warning.fix}`);
  }
  if (mount.path !== null) logger.info('app mcp mounted', { method: 'POST', path: mount.path });
  return mount;
}
