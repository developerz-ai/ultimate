// The app's own MCP endpoint, mounted by the web role. `defineAppMcp` built `mcp.route` — a
// `POST` handler with token auth and per-class rate limits — and `app.config.ts` declared
// `ai: { mcp: { expose: true } }` by DEFAULT, and nothing between the two served it:
// neither `x dev` nor `runRole` mounted the route, so `POST /mcp` answered `X_ROUTE_NOT_FOUND` in
// every app ever scaffolded (measured 2026-09-05). The contract is one file: `apps/<app>/mcp.ts`
// exports `mcp` — one `AppMcp`, or an array of them, one per population (customers, staff,
// affiliates) — this module finds it, and both boots mount what it carries: EVERY endpoint at its
// own `defineAppMcp({ path })`, the one path its RFC 9728 metadata and its 401 also name.

// why: a directory's existence — `Bun.file().exists()` answers for files, and `apps/` is a directory.
import { existsSync } from 'node:fs';
// why: Bun exposes no path-join primitive; each candidate is joined to root.
import { join } from 'node:path';
import { logger } from '@ultimat3/core';
import type { Route } from '@ultimat3/http';
import { json, selfOrigin } from '@ultimat3/http';
import {
  type AppMcp,
  McpAppUnmountedError,
  McpPathDuplicateError,
  PROTECTED_RESOURCE_WELL_KNOWN,
} from '@ultimat3/mcp';
import { loadAppConfig } from './app-config-load';

/** The one file an app writes, per app directory. */
export const APP_MCP_GLOB = 'apps/*/mcp.ts';
/**
 * The export that file makes — an `AppMcp`, the value `defineAppMcp` returns, or a non-empty array
 * of them. ONE export name either way: a second named export per endpoint would be a second way
 * to say the same thing, and the array's order is the one fact the mount needs (#0 is the default).
 */
export const APP_MCP_EXPORT = 'mcp';
/** What the boot line and `/_x` call endpoint #0's route; endpoint #n is `mcp:<its path>`. */
export const APP_MCP_ROUTE_NAME = 'mcp';

export interface AppMcpMount {
  /** `[]` when `expose` is false, when nothing exports `mcp`, or when no endpoint has a route. */
  readonly routes: readonly Route[];
  /** Endpoint #0's `POST <path>` when mounted, else `null` — the default endpoint. */
  readonly path: string | null;
  /** Every mounted endpoint's `POST <path>`, in export order — the boot line prints one each. */
  readonly paths: readonly string[];
  /**
   * Set when `expose` is true and an endpoint could not be mounted — nothing exports `mcp`, or the
   * first endpoint built without `resolveToken`: the reason, as an instruction. The endpoints that
   * could be mounted still are.
   */
  readonly warning: McpAppUnmountedError | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * `defineAppMcp`'s own default — `mcp/src/transport-http.ts`, `input.path ?? '/mcp'` — named here
 * ONLY in a warning about an endpoint that has no route and so no resolved path. It never decides
 * where anything mounts: a mounted endpoint's path is `route.path`.
 */
const UNROUTED_MCP_PATH = '/mcp';

/** `config.ai.mcp.expose` off the one loader (`app-config-load.ts`); false with no config file. */
async function exposed(root: string): Promise<boolean> {
  return (await loadAppConfig(root))?.ai.mcp.expose ?? false;
}

const isAppMcp = (value: unknown): value is AppMcp =>
  isRecord(value) && 'server' in value && 'tools' in value && 'route' in value;

/** The export as a list of endpoints, or `undefined` when it is not one (the "missing" case). */
function endpointsOf(exported: unknown): readonly AppMcp[] | undefined {
  if (isAppMcp(exported)) return [exported];
  if (!Array.isArray(exported) || exported.length === 0) return undefined;
  return exported.every(isAppMcp) ? (exported as readonly AppMcp[]) : undefined;
}

/** Every `apps/<app>/mcp.ts`, app-root-relative and sorted, so two apps answer in one order. */
async function candidates(root: string): Promise<readonly string[]> {
  // A root with no `apps/` is an app with no MCP file, never a boot failure — the scan's ENOENT
  // is answered as "none", and the warning below says which file to write.
  if (!existsSync(join(root, 'apps'))) return [];
  const files: string[] = [];
  for await (const file of new Bun.Glob(APP_MCP_GLOB).scan({ cwd: root })) files.push(file);
  return files.sort();
}

const NOTHING: AppMcpMount = { routes: [], path: null, paths: [], warning: undefined };

/**
 * The routes to mount, or the reason there are none. Pure over the filesystem it is pointed at;
 * `mountAppMcp` below is the one place the warning becomes a log line.
 *
 * `meta.auth: 'public'` and `enforcedBy: 'handler'` — the http pipeline must not pre-judge:
 * `mcp.route.handle` is the one evaluation, and it reads `Authorization: Bearer` through the
 * `resolveToken` the app gave `defineAppMcp`, then decides per tool through the same policy every
 * other surface evaluates. A pipeline `auth: 'required'` would demand a session cookie an agent
 * does not have and answer 401 before the token was ever read.
 */
export async function appMcpMount(root: string): Promise<AppMcpMount> {
  if (!(await exposed(root))) return NOTHING;
  const files = await candidates(root);
  const fallbackFile = 'apps/web/mcp.ts';
  for (const file of files) {
    const module = (await import(join(root, file))) as Record<string, unknown>;
    const endpoints = endpointsOf(module[APP_MCP_EXPORT]);
    if (endpoints === undefined) continue;
    return mountEndpoints(endpoints, file);
  }
  return {
    ...NOTHING,
    warning: new McpAppUnmountedError({
      reason: 'missing',
      path: UNROUTED_MCP_PATH,
      file: files[0] ?? fallbackFile,
    }),
  };
}

/**
 * One file's endpoints onto one route table. An endpoint built without `resolveToken` has no
 * route: it is skipped and the FIRST such is the warning, so one unfinished population never takes
 * the others down with it. Two endpoints on one route is thrown — see `McpPathDuplicateError`.
 */
function mountEndpoints(endpoints: readonly AppMcp[], file: string): AppMcpMount {
  const routes: Route[] = [];
  const paths: string[] = [];
  const claimed = new Map<string, number>();
  let warning: McpAppUnmountedError | undefined;
  endpoints.forEach((endpoint, index) => {
    const route = endpoint.route;
    if (route === undefined) {
      warning ??= new McpAppUnmountedError({
        reason: 'no-route',
        path: UNROUTED_MCP_PATH,
        file,
        ...(index === 0 ? {} : { endpoint: index }),
      });
      return;
    }
    // The descriptor's own path — the one its metadata, its `resourceUrl` and its 401 were built
    // over. A mount path from anywhere else is a resource advertised where nothing answers.
    const path = route.path;
    for (const mounted of endpointRoutes(route, path, index)) {
      const key = `${mounted.method} ${mounted.path}`;
      const first = claimed.get(key);
      if (first !== undefined) {
        throw new McpPathDuplicateError({
          method: mounted.method,
          path: mounted.path,
          endpoints: [first, index],
          file,
        });
      }
      claimed.set(key, index);
      routes.push(mounted);
    }
    paths.push(path);
  });
  return { routes, path: endpoints[0]?.route?.path ?? null, paths, warning };
}

type Descriptor = NonNullable<AppMcp['route']>;

/** One endpoint's `POST` and, when it declared `oauth`, its RFC 9728 metadata `GET`s. */
function endpointRoutes(route: Descriptor, path: string, index: number): readonly Route[] {
  const name = index === 0 ? APP_MCP_ROUTE_NAME : `${APP_MCP_ROUTE_NAME}:${path}`;
  const resource = route.protectedResource;
  // The ROOT document belongs to endpoint #0 alone: a client that probes the bare well-known URL
  // is asking about the default resource, and a second endpoint answering there would collide.
  // Every endpoint keeps its path-inserted document (RFC 9728 §3.1), which its own 401 names.
  const metadata: readonly Route[] =
    resource === undefined
      ? []
      : resource.paths
          .filter((metadataPath) => index === 0 || metadataPath !== PROTECTED_RESOURCE_WELL_KNOWN)
          .map(
            (metadataPath): Route => ({
              method: 'GET',
              path: metadataPath,
              handler: (_request, ctx) => {
                const response = json(resource.document(selfOrigin(ctx.url, ctx.https)));
                // A browser-hosted MCP client reads this cross-origin; it holds nothing secret.
                response.headers.set('access-control-allow-origin', '*');
                response.headers.set('cache-control', 'public, max-age=3600');
                return response;
              },
              meta: { name: `${name}.oauth-protected-resource`, auth: 'public' },
            }),
          );
  return [
    {
      method: 'POST',
      path,
      // The PUBLIC origin, as the pipeline resolved it (`ctx.https` honours a trusted proxy's
      // `x-forwarded-proto`): behind a TLS-terminating ingress the raw request URL is `http://`
      // on an internal host, and a `resource_metadata` naming that is a URL no client can reach.
      // The client ADDRESS likewise: failed tokens are metered per address, and the descriptor
      // has no other way to learn it.
      handler: (request, ctx) =>
        route.handle(request.raw, {
          origin: selfOrigin(ctx.url, ctx.https),
          address: ctx.ip ?? undefined,
        }),
      meta: { name, auth: 'public', enforcedBy: 'handler' },
    },
    ...metadata,
  ];
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
  for (const path of mount.paths) logger.info('app mcp mounted', { method: 'POST', path });
  return mount;
}
