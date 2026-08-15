// One function per stage name: what each stage of the lifecycle DOES. The package's three-way
// split, each file naming the other two — `pipeline.ts` owns the ORDER the stages run in and the
// run itself, `finalize.ts` owns the promise that the tail cannot reject, and this file owns the
// work. The vocabulary (`StageName`, `Stage`) lives here too, beside the twelve implementations
// it names, so `Record<StageName, StageRun>` below is the build error that catches a missing one.

import { anonymousActor, isAnonymous, logger, reportError } from '@ultimat3/core';
import { signInRedirect } from './auth-redirect';
import { defaultCache } from './cache-policy';
import { type HttpConfig, stripBasePath } from './config';
import { actorView, elapsedMs, type RequestContext } from './context';
import { corsHeaders, preflight } from './cors';
import { factsOf } from './error-map';
import {
  bodyInvalid,
  forbidden,
  methodNotAllowed,
  pathInvalid,
  rateLimited,
  routeNotFound,
  unauthenticated,
} from './errors';
import type { ServerHooks } from './hooks';
import { negotiateLocale, readCookie, resolveTimeZone } from './locale';
import { compose, type Middleware } from './middleware';
import { overlayResponse, wantsOverlay } from './overlay';
import { type RateLimiter, rateLimitKey } from './rate-limit';
import type { UltimateRequest } from './request';
import { addVary, applyCacheHeaders, problem, redirect } from './response';
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

export type StageRun = (
  request: UltimateRequest,
  ctx: RequestContext,
) => Response | undefined | Promise<Response | undefined>;

export interface Stage extends StageDoc {
  readonly run: StageRun;
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;
const REQUEST_ID = /^[\w.:-]{8,128}$/;

/**
 * The one label a request with no matched route may carry. Every 404 and every scan of `/wp-admin`
 * would otherwise be its own rate-limit bucket and its own metric series — an attacker choosing
 * the server's cardinality is how a Prometheus dies. Exported because `pipeline.ts` labels the
 * request metric with it too, and two spellings of "unmatched" is two series.
 */
export const UNMATCHED_ROUTE = 'unmatched';

/**
 * Everything a stage may read, named one by one rather than as `PipelineDeps`: a stage body has no
 * business seeing the constructor's input shape, and this list IS the answer to "what can a stage
 * depend on".
 */
export interface StageRunnersInput {
  readonly table: RouteTable;
  readonly config: HttpConfig;
  readonly limiter: RateLimiter;
  readonly hooks: ServerHooks;
  readonly middleware: readonly Middleware[];
}

/** The stage table, closed over one pipeline's config, routes, hooks and limiter. */
export const stageRunners = (input: StageRunnersInput): Record<StageName, StageRun> => {
  const { config, hooks, limiter } = input;
  const wrapped = new Map<Route, RouteHandler>();
  const wrap = compose(input.middleware);
  for (const route of input.table.routes) wrapped.set(route, wrap(route.handler));

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
      const match = matchRoute(input.table, ctx.method, pathname);
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
        applyCacheHeaders(
          response,
          ctx.cache ?? ctx.route?.meta.cache ?? defaultCache(ctx.route, ctx.actor),
        );
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
        // `vary` is the one header two stages both contribute to, so it is added and never set:
        // `set` here would drop the cache stage's key (`accept-language`, `cookie`) on the floor.
        if (name === 'vary') addVary(response, [value]);
        else response.headers.set(name, value);
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
