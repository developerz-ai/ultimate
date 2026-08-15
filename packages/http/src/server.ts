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
import { serverNotStarted } from './errors';
import type { ServerHooks } from './hooks';
import type { Middleware } from './middleware';
import { createPipeline, type Pipeline } from './pipeline';
import { createRateLimiter, type RateLimitStore } from './rate-limit';
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
  const config = options.config ?? defineHttpConfig();
  const role = options.role ?? roleFromEnv();
  const table = createRouter(options.routes);
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

  // The one HTTP-owned knob feeds core's deadline, so there is a single drain budget.
  configureLifecycle({ deadlineMs: config.drainTimeoutMs });

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
   * Static paths go into Bun's native route table so path dispatch happens in
   * native code. Method resolution stays ours: Bun's automatic 405 would not carry
   * our problem+json body. Param/wildcard paths fall through to `fetch`.
   */
  const nativeRoutes = (): Record<string, NativeHandler> => {
    const out: Record<string, NativeHandler> = {};
    const prefix = config.basePath === '/' ? '' : config.basePath.replace(/\/$/, '');
    for (const description of describeRoutes(table)) {
      if (description.params.length > 0) continue;
      out[`${prefix}${description.path}`] = dispatch;
    }
    return out;
  };

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
      server = Bun.serve({
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
        fetch: (request, socket) => dispatch(request, socket),
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

      markReady();
      logger.info(`ultimate ${role} listening on ${server.url.origin}`);
      return handle;
    },
    async stop() {
      if (server === undefined) return;
      try {
        // Delegate to core so a manual stop() and a real SIGTERM take the identical
        // three-phase path. The drain deadline is core's, not ours.
        await drain('manual');
      } finally {
        // A throwing drain() must not leave this handle's hooks registered against a server
        // that is going away — core would still call them, against `server` fields already
        // torn down below, on the next drain this process runs.
        unregister?.();
        unregisterClose?.();
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
