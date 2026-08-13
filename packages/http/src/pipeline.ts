// THE request lifecycle. An explicit, ordered array — not a middleware stack — because
// this order IS the framework's guarantee: context before user code, identity before
// rate limiting, validation before authz, authz before the handler. Nothing can skip a
// stage, and the array is exported so `/_x` renders it and pipeline.test.ts asserts it.
import {
  anonymousActor,
  isAnonymous,
  logger,
  recordRequest,
  reportError,
  runWithContext,
  withSpan,
} from '@ultimat3/core';
import { signInRedirect } from './auth-redirect';
import { defineHttpConfig, type HttpConfig, stripBasePath } from './config';
import { actorView, asCtx, createRequestContext, elapsedMs, type RequestContext } from './context';
import { corsHeaders, preflight } from './cors';
import { factsOf } from './error-map';
import {
  bodyInvalid,
  forbidden,
  methodNotAllowed,
  pathInvalid,
  pipelineNoResponse,
  rateLimited,
  routeNotFound,
  unauthenticated,
} from './errors';
import { recoverWith, runFinalize } from './finalize';
import type { ServerHooks } from './hooks';
import { negotiateLocale, readCookie, resolveTimeZone } from './locale';
import { compose, type Middleware } from './middleware';
import { overlayResponse, wantsOverlay } from './overlay';
import { createRateLimiter, type RateLimiter, rateLimitKey } from './rate-limit';
import { UltimateRequest } from './request';
import { applyCacheHeaders, type CacheHint, problem, redirect } from './response';
import { matchRoute, type Route, type RouteHandler, type RouteTable } from './router';
import { securityHeaders } from './security-headers';
import { validate } from './validate';

export type StageName =
  | 'request-id'
  | 'trace'
  | 'context'
  | 'locale'
  | 'auth'
  | 'rate-limit'
  | 'body'
  | 'authz'
  | 'handler'
  | 'cache-headers'
  | 'error-map'
  | 'response';

/**
 * `request`  may short-circuit by returning a Response.
 * `terminal` runs the route handler.
 * `recover`  runs only when something above threw.
 * `finalize` always runs, on success and on failure.
 */
export type StagePhase = 'request' | 'terminal' | 'recover' | 'finalize';

export interface StageDoc {
  readonly name: StageName;
  readonly phase: StagePhase;
  /** Why the stage sits at this index. Rendered verbatim by the dev dashboard. */
  readonly why: string;
}

export const PIPELINE_STAGES: readonly StageDoc[] = [
  {
    name: 'request-id',
    phase: 'request',
    why: 'first: every log line, span, error body and problem document quotes it, so it must exist before anything can fail',
  },
  {
    name: 'trace',
    phase: 'request',
    why: 'before any I/O: a span started later would silently exclude auth and DB latency from the trace',
  },
  {
    name: 'context',
    phase: 'request',
    why: 'creates the ambient context and binds the matched route; build skew is checked here because a stale client must be told to reload before it gets a 404 for a route it no longer knows',
  },
  {
    name: 'locale',
    phase: 'request',
    why: 'before auth: even a 401 body is localised, and no date/money formatter may run without an explicit locale + IANA tz',
  },
  {
    name: 'auth',
    phase: 'request',
    why: 'before rate limiting so the limiter keys per actor and per tenant instead of punishing a shared NAT address',
  },
  {
    name: 'rate-limit',
    phase: 'request',
    why: 'before the body is read: a limited request must never make the server allocate its payload',
  },
  {
    name: 'body',
    phase: 'request',
    why: 'before authz because policies take the parsed input as their subject (ownsPost(actor, input.postId))',
  },
  {
    name: 'authz',
    phase: 'request',
    why: 'the last gate, and only for a route whose policy nothing downstream evaluates: one policy, decided here exactly as it is in jobs, live queries and MCP tools. A route marked enforcedBy: handler is skipped, because its handler holds the row this stage cannot load',
  },
  { name: 'handler', phase: 'terminal', why: 'the only stage that is app code' },
  {
    name: 'cache-headers',
    phase: 'finalize',
    why: 'after the handler so a handler can override the route default, and before response so a directive cannot drop a security header',
  },
  {
    name: 'error-map',
    phase: 'recover',
    why: 'the single place a throw becomes a status: problem+json for agents and RPC, the dev overlay for browsers',
  },
  {
    name: 'response',
    phase: 'finalize',
    why: 'last: CORS, security headers, server-timing and the accumulated context headers are merged onto whatever the stages produced',
  },
];

export type StageRun = (
  request: UltimateRequest,
  ctx: RequestContext,
) => Response | undefined | Promise<Response | undefined>;

export interface Stage extends StageDoc {
  readonly run: StageRun;
}

export interface PipelineDeps {
  readonly table: RouteTable;
  readonly config?: HttpConfig;
  readonly hooks?: ServerHooks;
  readonly middleware?: readonly Middleware[];
  readonly limiter?: RateLimiter;
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;
const REQUEST_ID = /^[\w.:-]{8,128}$/;

/**
 * The one label a request with no matched route may carry. Every 404 and every scan of `/wp-admin`
 * would otherwise be its own rate-limit bucket and its own metric series — an attacker choosing
 * the server's cardinality is how a Prometheus dies.
 */
const UNMATCHED_ROUTE = 'unmatched';

/** Authenticated routes are never shared-cacheable; that default is not overridable. */
const defaultCache = (route: Route | undefined): CacheHint =>
  route === undefined || route.meta.auth === 'required'
    ? { mode: 'no-store' }
    : { mode: 'public', maxAgeSeconds: 0, sMaxAgeSeconds: 60, staleWhileRevalidateSeconds: 600 };

const runners = (deps: PipelineDeps, config: HttpConfig, limiter: RateLimiter) => {
  const hooks = deps.hooks ?? {};
  const wrapped = new Map<Route, RouteHandler>();
  const wrap = compose(deps.middleware ?? []);
  for (const route of deps.table.routes) wrapped.set(route, wrap(route.handler));

  const table: Record<StageName, StageRun> = {
    'request-id': (request, ctx) => {
      const inbound = config.trustProxy ? request.header('x-request-id') : null;
      if (inbound !== null && REQUEST_ID.test(inbound)) ctx.requestId = inbound;
      ctx.headers.set('x-request-id', ctx.requestId);
      return undefined;
    },

    trace: (request, ctx) => {
      const inbound = request.header('traceparent');
      const parsed = inbound === null ? null : TRACEPARENT.exec(inbound);
      if (parsed !== null) {
        ctx.traceId = parsed[1] ?? ctx.traceId;
        ctx.parentSpanId = parsed[2] ?? null;
      }
      ctx.headers.set('x-trace-id', ctx.traceId);
      return undefined;
    },

    context: (request, ctx) => {
      // A preflight carries no credentials, so answering it after `auth` would 401
      // every legitimate cross-origin call.
      const answered = preflight(request.raw, config.cors);
      if (answered !== undefined) return answered;

      ctx.buildId = request.header(config.buildIdHeader);
      request.assertBuild();

      const pathname = stripBasePath(ctx.url.pathname, config.basePath);
      const match = matchRoute(deps.table, ctx.method, pathname);
      if (!match.ok) {
        if (match.reason === 'not-found') throw routeNotFound(ctx.method, pathname);
        if (match.reason === 'path-invalid') throw pathInvalid(pathname, match.segment);
        ctx.headers.set('allow', match.allow.join(', '));
        throw methodNotAllowed(ctx.method, pathname, match.allow);
      }
      ctx.route = match.route;
      ctx.params = match.params;
      return undefined;
    },

    locale: (request, ctx) => {
      const cookies = request.header('cookie');
      ctx.locale = negotiateLocale(
        request.header('accept-language'),
        config.locale,
        readCookie(cookies, config.locale.cookie),
      );
      ctx.tz = resolveTimeZone(
        request.header(config.tz.header) ?? readCookie(cookies, config.tz.cookie),
        config.tz,
      );
      ctx.headers.set('content-language', ctx.locale);
      return undefined;
    },

    auth: async (request, ctx) => {
      if (hooks.authenticate !== undefined) {
        // The hook says "anonymous" with null; the context says it with core's anonymous actor,
        // because `asCtx` publishes this object as a `Ctx` and `Ctx.actor` is never null.
        ctx.actor = (await hooks.authenticate(request, ctx)) ?? anonymousActor();
      }
      if (ctx.route?.meta.auth === 'required' && isAnonymous(ctx.actor)) {
        throw unauthenticated(ctx.url.pathname);
      }
      return undefined;
    },

    'rate-limit': async (_request, ctx) => {
      if (!config.rateLimit.enabled) return undefined;
      const actor = actorView(ctx.actor);
      const key = rateLimitKey({
        actorId: actor?.id ?? null,
        orgId: actor?.orgId ?? null,
        ip: ctx.ip,
        routeName: ctx.route?.meta.name ?? UNMATCHED_ROUTE,
      });
      const decision = await limiter.check(
        key,
        ctx.route?.meta.rateLimit ?? config.rateLimit.defaultBucket,
      );
      // Recorded before the throw so the 429 can carry Retry-After and the
      // RateLimit-* headers rather than making the client guess.
      ctx.rateLimit = decision;
      for (const [name, value] of Object.entries(limiter.headers(decision))) {
        ctx.headers.set(name, value);
      }
      if (!decision.allowed) throw rateLimited(key, decision.retryAfterSeconds);
      return undefined;
    },

    body: async (request, ctx) => {
      const schema = ctx.route?.meta.input;
      if (schema === undefined) return undefined;
      const outcome = await validate(schema, await request.bodyRaw());
      if (!outcome.ok) throw bodyInvalid(ctx.url.pathname, outcome.issues);
      ctx.input = outcome.value;
      return undefined;
    },

    authz: async (request, ctx) => {
      const route = ctx.route;
      if (route === undefined || route.meta.policy === undefined) return undefined;
      // The handler owns this route's single evaluation (`RouteMeta.enforcedBy`). Deciding
      // here as well would be a second authz system holding strictly less than the first —
      // no row — and it is the one that answers first, so it is the one that would win.
      if (route.meta.enforcedBy === 'handler') return undefined;
      if (hooks.authorize === undefined) {
        // A declared policy with no evaluator is a wiring bug, and failing open
        // here is exactly how a framework ends up with two authz systems.
        throw forbidden(ctx.url.pathname, `no authorizer wired for policy ${route.meta.policy}`);
      }
      const decision = await hooks.authorize(route, request, ctx);
      ctx.authz = decision;
      if (!decision.allowed) throw forbidden(ctx.url.pathname, decision.reason);
      return undefined;
    },

    handler: async (request, ctx) => {
      const route = ctx.route;
      if (route === undefined) throw routeNotFound(ctx.method, ctx.url.pathname);
      const handler = wrapped.get(route) ?? route.handler;
      return await handler(request, ctx);
    },

    'cache-headers': (_request, ctx) => {
      const response = ctx.response;
      if (response === undefined) return undefined;
      if (!response.headers.has('cache-control')) {
        applyCacheHeaders(response, ctx.cache ?? ctx.route?.meta.cache ?? defaultCache(ctx.route));
      }
      return undefined;
    },

    'error-map': (request, ctx) => {
      const error = ctx.error;
      const facts = factsOf(error);
      // This package's ONE error-reporting call site, and it is the framework's own — `onError`
      // below stays the APP's sink. 5xx only: a 404 or a 422 is the caller's mistake, the problem
      // document already told them, and a monitor that also holds those is a log nobody reads.
      // The `operation` is the route PATTERN for the same reason `recordRequest` uses it.
      if (facts.status >= 500) {
        reportError(error, {
          source: 'http',
          scope: {
            requestId: ctx.requestId,
            traceId: ctx.traceId,
            role: ctx.role,
            operation: `${ctx.method} ${ctx.route?.path ?? UNMATCHED_ROUTE}`,
            actorId: isAnonymous(ctx.actor) ? undefined : ctx.actor.id,
          },
        });
      }
      hooks.onError?.(error, ctx);
      logger.error(`${facts.code}: ${facts.cause} [${ctx.requestId}]`);
      // Before the overlay and before the problem document: a browser with no session has not
      // hit a defect to debug, it has hit a login wall, and the answer to that is the sign-in
      // page. `signInPath` is null until an app declares one, so this is off by default.
      const toSignIn = signInRedirect({
        code: facts.code,
        signInPath: config.signInPath,
        request: request.raw,
        ctx,
      });
      if (toSignIn !== undefined) return redirect(toSignIn.location, toSignIn.status);
      if (config.dev && wantsOverlay(request.raw)) {
        // Asked for inside the branch, never above it: the overlay is the only surface a notice
        // has, so a production process — or an agent that asked for json — must not pay a
        // diagnostic's per-request cost to produce findings nothing will render.
        const notices = hooks.devNotices?.(ctx) ?? [];
        return overlayResponse(error, {
          requestId: ctx.requestId,
          method: ctx.method,
          path: ctx.url.pathname,
          buildId: config.buildId,
          ...(notices.length === 0 ? {} : { notices }),
        });
      }
      const retryAfter =
        facts.code === 'X_RATE_LIMITED' && ctx.rateLimit !== undefined
          ? { 'retry-after': String(ctx.rateLimit.retryAfterSeconds) }
          : {};
      return problem(error, {
        instance: ctx.url.pathname,
        requestId: ctx.requestId,
        headers: retryAfter,
      });
    },

    response: (request, ctx) => {
      const response = ctx.response;
      if (response === undefined) return undefined;
      for (const [name, value] of ctx.headers) response.headers.set(name, value);
      for (const [name, value] of Object.entries(
        corsHeaders(config.cors, request.header('origin')),
      )) {
        response.headers.set(name, value);
      }
      for (const [name, value] of Object.entries(
        securityHeaders(config.security, { https: ctx.https }),
      )) {
        response.headers.set(name, value);
      }
      response.headers.set('server-timing', `total;dur=${elapsedMs(ctx)}`);
      return undefined;
    },
  };
  return table;
};

export interface HandleInit {
  readonly role: RequestContext['role'];
  readonly ip?: string | null;
}

export interface Pipeline {
  readonly stages: readonly Stage[];
  readonly config: HttpConfig;
  /**
   * Runs the full lifecycle for one request and always resolves to a Response — a stage that
   * throws after the handler, or while rendering another stage's throw, degrades to the coded
   * 500 (`X_PIPELINE_FINALIZE_FAILED`) rather than rejecting. A caller has a socket open.
   */
  handle(request: Request, init: HandleInit): Promise<Response>;
}

export const createPipeline = (deps: PipelineDeps): Pipeline => {
  const config = deps.config ?? defineHttpConfig();
  const limiter = deps.limiter ?? createRateLimiter({ config: config.rateLimit });
  const run = runners(deps, config, limiter);
  const stages: readonly Stage[] = PIPELINE_STAGES.map((doc) => ({ ...doc, run: run[doc.name] }));

  const byPhase = (phase: StagePhase): readonly Stage[] =>
    stages.filter((stage) => stage.phase === phase);
  const requestStages = byPhase('request');
  const finalizeStages = byPhase('finalize');
  const terminal = stages.find((stage) => stage.phase === 'terminal');
  const recovered = recoverWith(stages.find((stage) => stage.phase === 'recover'));

  const execute = async (request: UltimateRequest, ctx: RequestContext): Promise<Response> => {
    try {
      for (const stage of requestStages) {
        const short = await stage.run(request, ctx);
        if (short !== undefined) {
          ctx.response = short;
          break;
        }
      }
      if (ctx.response === undefined && terminal !== undefined) {
        ctx.response = (await terminal.run(request, ctx)) ?? new Response(null, { status: 204 });
      }
    } catch (error) {
      ctx.error = error;
      ctx.response = await recovered(request, ctx);
    }
    // `finalize.ts`, not a loop here: these two stages run after the request is already answered
    // or already failed, so a throw of their own has nothing left to catch it — and `handle`
    // promises a Response.
    await runFinalize(finalizeStages, request, ctx, recovered);
    return ctx.response ?? problem(pipelineNoResponse('response'));
  };

  return {
    stages,
    config,
    async handle(raw, init) {
      const url = new URL(raw.url);
      const ctx = createRequestContext({
        url,
        method: raw.method,
        role: init.role,
        config,
        ip: init.ip ?? null,
        // The context is what app code reaches through core's ALS; without the inbound headers
        // on it, a cookie the server itself set could never be read back on the next request,
        // and `ctx.session` had no way to exist.
        requestHeaders: raw.headers,
      });
      const request = new UltimateRequest(raw, ctx);
      // The ALS scope is entered here, before stage 1, so every stage — and everything
      // a handler calls — sees the same context object without threading it by hand.
      return await runWithContext(asCtx(ctx), () =>
        withSpan(
          `${ctx.method} ${url.pathname}`,
          async (span) => {
            // This package's ONE metrics call site. `finally`, not the happy line: `execute`
            // answers every stage's throw with a problem response, but a counter that skipped the
            // requests the server handled worst is the one an autoscaler must not have — so a
            // rejection nothing here predicted still counts, at the 500 such a request gets from
            // the caller either way.
            let status = 500;
            try {
              const response = await execute(request, ctx);
              status = response.status;
              // The root span of every request carried no attributes at all, so an exporter got a
              // name and a duration and nothing to correlate: which request, which outcome. These
              // four are what a reader joins on — `x-request-id` off the response, the status the
              // client saw, and the method/path split out of the span name.
              span.setAttributes({
                'http.request_id': ctx.requestId,
                'http.method': ctx.method,
                'http.route': url.pathname,
                'http.status_code': response.status,
              });
              return response;
            } finally {
              // The span may carry the concrete path — a trace is sampled and thrown away. A
              // metric is a stored series per label set, so this is the route PATTERN
              // (`/posts/:id`), and `recordRequest` folds the status to its class for the same
              // reason. Nothing here is attacker-chosen or per-user.
              recordRequest({
                method: ctx.method,
                route: ctx.route?.path ?? UNMATCHED_ROUTE,
                status,
                durationMs: elapsedMs(ctx),
              });
            }
          },
          { kind: 'server' },
        ),
      );
    },
  };
};
