// We own the server lifecycle instead of exposing `Bun.serve` directly, because ALS
// context, tracing and authz must be impossible to skip — a route is a data
// declaration, never a chance to hand-roll a request handler.

import type { HealthPayload, HealthState, Role } from '@ultimat3/core';
import {
  beginWork,
  configureLifecycle,
  drain,
  healthzPayload,
  lifecycleState,
  logger,
  markListening,
  markReady,
  onShutdown,
  readyzPayload,
} from '@ultimat3/core';
import type { Server } from 'bun';
import { defineHttpConfig, type HttpConfig } from './config';
import { serverNotStarted, websocketPathTaken } from './errors';
import type { ServerHooks } from './hooks';
import type { Middleware } from './middleware';
import { createPipeline, type Pipeline } from './pipeline';
import { createRateLimiter, type RateLimitStore } from './rate-limit';
import { withRouteBuckets } from './rate-limit-buckets';
import { json } from './response';
import { createRouter, describeRoutes, type Route, type RouteDescription } from './router';

/** Core owns the state machine; this alias exists so callers need one import. */
export type LifecycleState = HealthState;

/** `Server` is generic over its websocket payload; the `web` role does not use one. */
type BunServer = Server<unknown>;

type NativeHandler = (request: Request, socket: BunServer) => Promise<Response>;

export interface ServerOptions {
  readonly routes: readonly Route[];
  readonly config?: HttpConfig;
  /** `ROLE` env selects behaviour; one image, N processes. */
  readonly role?: Role;
  readonly hooks?: ServerHooks;
  readonly middleware?: readonly Middleware[];
  /**
   * Where the rate limiter keeps its counters. Omitted means `memoryRateLimitStore()`, which is
   * one process' worth of state — correct for dev and tests, and N × every configured number for
   * N replicas. An app that runs more than one process declares `rateLimit.scope: 'shared'` and
   * passes a store that says the same, or `createServer` refuses here.
   */
  readonly rateLimitStore?: RateLimitStore;
  /**
   * A websocket served on THIS socket, beside the pipeline. Omitted, the `web` role opens no
   * websocket at all — which is what it did everywhere, and is why the sync node was only ever
   * reachable on a port of its own.
   *
   * The problem that is: `PORT + 1` is a rule the app's own origin cannot express. A browser that
   * reaches the app through anything that publishes ONE port — VS Code's remote port forwarding,
   * a Codespace, an ingress, a tunnel — loads the page and then dials a neighbour nobody
   * forwarded. Measured 2026-09-07 over a VSCodium Remote-SSH workspace: the page on the
   * forwarded `localhost:3000` rendered, `ws://localhost:3001/_x/sync` failed on every attempt of
   * the reconnect ladder, and the same upgrade answered `101` from the box itself. Nothing was
   * broken on either end — there was no tunnel between them.
   *
   * So a host may mount the socket on the port it already publishes, and the two-port topology
   * stays exactly as it was: `x dev` does BOTH, `docker/` keeps its own `sync` service, and a
   * client picks whichever origin it can actually reach.
   */
  readonly websocket?: WebSocketMount;
}

/**
 * Structural view of `Bun.serve`'s server object, as much of one as an upgrade reads. Here rather
 * than imported from `bun` so a mount can be written — and tested — without one, the same shape
 * `@ultimat3/realtime`'s own `UpgradeTarget` already has: this option is the seam those two
 * packages meet at, and neither may depend on the other.
 */
export interface UpgradeTarget {
  upgrade(request: Request, options: { data: unknown }): boolean;
}

/**
 * One path, taken off the pipeline and answered by a websocket host instead.
 *
 * `fetch` returning `undefined` means the upgrade TOOK and Bun owns the connection now — the
 * convention `Bun.serve` itself uses, and the one `SyncNode.fetch` already speaks, so a node is a
 * mount with no adapter in between. A `Response` is a refusal (`426`, `401`, a shed `503`) and is
 * returned as it is.
 *
 * The handlers are structural for the reason above; `open`, `message` and `close` are declared as
 * METHODS on purpose, so a host that types its socket precisely (`SyncWs`) still satisfies this.
 */
export interface WebSocketMount<TSocket = never> {
  /** The one path this mount owns. Every other request goes to the pipeline, untouched. */
  readonly path: string;
  fetch(
    request: Request,
    server: UpgradeTarget,
  ): Promise<Response | undefined> | Response | undefined;
  readonly websocket: {
    open(ws: TSocket): void;
    message(ws: TSocket, message: string | Uint8Array): void;
    close(ws: TSocket): void;
    readonly idleTimeout?: number;
    readonly backpressureLimit?: number;
    readonly maxPayloadLength?: number;
    readonly sendPings?: boolean;
  };
}

export interface ServerHandle {
  readonly role: Role;
  readonly config: HttpConfig;
  readonly pipeline: Pipeline;
  state(): LifecycleState;
  /** `http://host:port` once started; throws before `start()`. */
  url(): string;
  describe(): readonly RouteDescription[];
  start(): ServerHandle;
  /** Runs core's three-phase drain. The deadline is `config.drainTimeoutMs`. */
  stop(): Promise<void>;
  /**
   * Runs one request through the entire lifecycle with no socket. This is the
   * supported way to test routes: there is no second, "lighter" code path.
   */
  fetch(request: Request): Promise<Response>;
}

const roleFromEnv = (): Role => (Bun.env['ROLE'] ?? 'web') as Role;

export const createServer = (options: ServerOptions): ServerHandle => {
  const role = options.role ?? roleFromEnv();
  const table = createRouter(options.routes);
  // Merged here as well as in `createPipeline`, and for the store's sake: the limiter below is
  // built from `config.rateLimit`, so a table without the routes' own buckets would resolve a
  // declared name to `default` — the very hole this closes. `withRouteBuckets` is idempotent, so
  // the pipeline's second pass changes nothing. `handle.config` is the merged one for the same
  // reason: `server.config.rateLimit.buckets` has to be what the limiter runs on.
  const config = withRouteBuckets(options.config ?? defineHttpConfig(), table.routes);
  // The store feeds the limiter seam `PipelineDeps` already had, rather than becoming a second
  // one: the bucket maths stays in `createRateLimiter`, so every driver agrees on the numbers.
  const pipeline = createPipeline({
    table,
    config,
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
    ...(options.middleware === undefined ? {} : { middleware: options.middleware }),
    ...(options.rateLimitStore === undefined
      ? {}
      : {
          limiter: createRateLimiter({ config: config.rateLimit, store: options.rateLimitStore }),
        }),
  });

  // The one HTTP-owned knob feeds core's deadline, so there is a single drain budget — and only
  // when this app DECLARED it. Unconditional, with `defineHttpConfig` defaulting the number, this
  // line reverted `configureLifecycle({ deadlineMs: 600_000 })` — the edit `X_SHUTDOWN_TIMEOUT`'s
  // own `fix:` prints — back to 15s on every boot that serves web, silently. "Nobody said" and
  // "the app said 15 seconds" are different claims and `null` is what keeps them apart.
  if (config.drainTimeoutMs !== null) configureLifecycle({ deadlineMs: config.drainTimeoutMs });

  const mount = options.websocket;
  let server: BunServer | undefined;
  let unregister: (() => void) | undefined;
  let unregisterClose: (() => void) | undefined;
  let stopListening: (() => void) | undefined;

  /**
   * Core owns the health state, the in-flight count and the drain deadline so every
   * role reports identically. `HealthPayload` is `{ ok, status, body }` — core stays
   * HTTP-free and hands us the status code as data, which we render here.
   */
  const healthResponse = (payload: HealthPayload): Response =>
    json(
      { ...payload.body, role },
      { status: payload.status, headers: { 'cache-control': 'no-store' } },
    );

  const dispatch = async (request: Request, socket?: BunServer): Promise<Response> => {
    // beginWork() is what makes the `inflight` drain phase correct: core cannot finish
    // in-flight work it does not know about.
    const done = beginWork();
    try {
      return await pipeline.handle(request, {
        role,
        ip: socket?.requestIP(request)?.address ?? null,
      });
    } finally {
      done();
    }
  };

  /**
   * The path alone. `new URL` rather than a string scan: a mount's path has to match what the
   * router would have matched, and `/_x/sync?build=abc` is that path with a query on it.
   */
  const pathOf = (request: Request): string => new URL(request.url).pathname;

  /** What Bun's native table is keyed by, and what a mount's path is compared against. */
  const prefix = config.basePath === '/' ? '' : config.basePath.replace(/\/$/, '');

  /**
   * Static paths go into Bun's native route table so path dispatch happens in
   * native code. Method resolution stays ours: Bun's automatic 405 would not carry
   * our problem+json body. Param/wildcard paths fall through to `fetch`.
   */
  const nativeRoutes = (): Record<string, NativeHandler> => {
    const out: Record<string, NativeHandler> = {};
    for (const description of describeRoutes(table)) {
      if (description.params.length > 0) continue;
      out[`${prefix}${description.path}`] = dispatch;
    }
    return out;
  };

  /**
   * A mount OWNS its path — and the table above is matched BEFORE `fetch`, so a static route (or a
   * health endpoint) at the same path would take the upgrade request and answer it with a
   * document: a websocket that never opens, and no error anywhere saying why. A param route cannot
   * do that; it falls through to `fetch`, where the mount is asked first.
   *
   * Refused here rather than ranked, because either precedence is a surprise: a route silently
   * shadowing the socket is the bug, and a mount silently shadowing a declared route would be the
   * worse one. `X_ROUTE_CONFLICT` is the code two routes claiming one path already get.
   */
  const assertMountPathFree = (path: string): void => {
    if (path === '/healthz' || path === '/readyz')
      throw websocketPathTaken(path, 'the health endpoint');
    for (const description of describeRoutes(table)) {
      if (description.params.length > 0) continue;
      if (`${prefix}${description.path}` === path)
        throw websocketPathTaken(path, `the route \`${description.name}\``);
    }
  };
  if (mount !== undefined) assertMountPathFree(mount.path);

  const handle: ServerHandle = {
    role,
    config,
    pipeline,
    state: () => lifecycleState(),
    url: () => {
      if (server === undefined) throw serverNotStarted('url()');
      return server.url.origin;
    },
    describe: () => describeRoutes(table),
    fetch: (request) => dispatch(request),
    start() {
      // FIRST, before the socket. `markReady()` refuses a process whose lifecycle already drained
      // (`X_LIFECYCLE_DRAINED`), and a refusal that arrived after the bind would leave a listener
      // this handle can never close: `drain()` memoized on the first drain, so `stop()` below never
      // reaches the close hook — measured, a second server was still accepting connections after
      // its own `stop()` returned, answering 503 to everything in between.
      //
      // The promotion moving above the bind costs nothing observable: `Bun.serve` is synchronous,
      // and `/readyz` is served by the socket this line precedes. `x dev`'s only earlier listener
      // is the metrics endpoint, which answers `METRICS_PATH` and nothing else.
      markReady();

      const listen = {
        port: config.port,
        hostname: config.hostname,
        development: config.dev,
        routes: {
          ...nativeRoutes(),
          // Health endpoints answer outside the pipeline on purpose: a draining or
          // rate-limited process must still be able to say what it is doing.
          '/healthz': () => healthResponse(healthzPayload()),
          '/readyz': () => healthResponse(readyzPayload()),
        },
      };
      // Two calls, not one options object with a spread: `Bun.serve` types `fetch` as returning a
      // `Response` UNLESS `websocket` is present, and a conditionally-spread key leaves TypeScript
      // on the first overload — where the `undefined` that means "upgraded" is an error. The
      // mount's path is not in `routes` either: a native route answers before `fetch` runs, and
      // an upgrade that never reaches `fetch` is a 404 with a websocket waiting behind it.
      server =
        mount === undefined
          ? Bun.serve({ ...listen, fetch: (request, socket) => dispatch(request, socket) })
          : Bun.serve({
              ...listen,
              fetch: async (request, socket) =>
                pathOf(request) === mount.path
                  ? await mount.fetch(request, socket as unknown as UpgradeTarget)
                  : await dispatch(request, socket),
              websocket: mount.websocket,
            });

      // Tell core which socket we opened. A request to it is this process calling itself,
      // so the test seal can let it through without an allowlist entry per random port.
      stopListening = markListening(server.url.origin);

      // 'accept' runs first on SIGTERM: readyz flips to 503 here, while the socket is
      // still open, so the load balancer stops sending new work before we close it.
      unregister = onShutdown(
        `http:${role}`,
        async () => {
          await server?.stop(false);
        },
        { phase: 'accept' },
      );
      // 'close' runs after core has waited out the in-flight phase.
      unregisterClose = onShutdown(
        `http:${role}:close`,
        async () => {
          await server?.stop(true);
          server = undefined;
          stopListening?.();
        },
        { phase: 'close' },
      );

      logger.info(`ultimate ${role} listening on ${server.url.origin}`);
      return handle;
    },
    async stop() {
      // Handed back FIRST, above every early return: on the SIGTERM path the `close` hook has
      // already set `server = undefined`, so `if (server === undefined) return` skipped the
      // release in the `finally` below for exactly the path production takes — two hooks left
      // registered against a socket that is gone, per server, per lifecycle, which is the leak
      // core's `shutdownHookCount()` exists to make visible. The shape `worker.ts`'s teardown
      // holds: the unregisters are the closure's, not the drain's.
      const releaseHooks = (): void => {
        unregister?.();
        unregisterClose?.();
        unregister = undefined;
        unregisterClose = undefined;
      };
      if (server === undefined) {
        releaseHooks();
        // Idempotent, and this path reaches it too: the close hook released the announcement, or
        // the deadline cut it short and nobody did.
        stopListening?.();
        stopListening = undefined;
        return;
      }
      try {
        // Delegate to core so a manual stop() and a real SIGTERM take the identical
        // three-phase path. The drain deadline is core's, not ours.
        await drain('manual');
      } finally {
        // A throwing drain() must not leave this handle's hooks registered against a server
        // that is going away — core would still call them, against `server` fields already
        // torn down below, on the next drain this process runs.
        releaseHooks();
      }
      // Idempotent: the close hook already released, unless the drain deadline cut it short.
      stopListening?.();
      stopListening = undefined;
      server = undefined;
      logger.info(`ultimate ${role} stopped`);
    },
  };

  return handle;
};
