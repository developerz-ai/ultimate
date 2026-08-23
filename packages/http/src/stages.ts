// One function per stage name: what each stage of the lifecycle DOES. The package's three-way
// split, each file naming the other two — `pipeline.ts` owns the ORDER the stages run in and the
// run itself, `finalize.ts` owns the promise that the tail cannot reject, and this file owns the
// work. The vocabulary (`StageName`, `Stage`) lives here too, beside the fourteen implementations
// it names, so `Record<StageName, StageRun>` below is the build error that catches a missing one.

import {
  anonymousActor,
  inflightCount,
  isAnonymous,
  isDraining,
  reportError,
} from '@ultimat3/core';
import { resolveLocale } from '@ultimat3/i18n';
import { resolveTimeZone } from '@ultimat3/time';
import { signInRedirect } from './auth-redirect';
import { defaultCache } from './cache-policy';
import { type HttpConfig, stripBasePath } from './config';
import { actorView, elapsedMs, type RequestContext } from './context';
import { corsHeaders, preflight } from './cors';
import { checkCsrf, selfOrigin } from './csrf';
import { factsOf, retryAfterOf } from './error-map';
import { errorPageResponse } from './error-page';
import {
  bodyInvalid,
  csrfBlocked,
  draining,
  forbidden,
  methodNotAllowed,
  overloaded,
  pathInvalid,
  routeNotFound,
  unauthenticated,
} from './errors';
import type { ServerHooks } from './hooks';
import { acceptsHtml } from './html-render';
import { readCookie } from './locale';
import { compose, type Middleware } from './middleware';
import { overlayResponse } from './overlay';
import { type RateLimiter, rateLimitKey } from './rate-limit';
import { rateLimited } from './rate-limit-errors';
import type { UltimateRequest } from './request';
import { addVary, applyCacheHeaders, problem, redirect } from './response';
import { matchRoute, type Route, type RouteHandler, type RouteTable } from './router';
import { securityHeaders } from './security-headers';
import { validate } from './validate';

export type StageName =
  | 'request-id'
  | 'admit'
  | 'trace'
  | 'context'
  | 'locale'
  | 'auth'
  | 'rate-limit'
  | 'csrf'
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

/**
 * A shed request must say when to come back, or it comes back immediately and the retry storm is
 * the load it was shed to avoid. One second: long enough to matter across a fleet, short enough
 * that a client is not parked past a rolling restart.
 */
const SHED_RETRY_AFTER_SECONDS = '1';

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
    // Both ids are resolved in `correlation.ts`, before the context and the root span exist —
    // this stage publishes what was decided there. It used to DECIDE, one frame after
    // `withSpan` had already frozen the span's parent, so an inbound `traceparent` was read into
    // `ctx.traceId` and the span kept a trace id nothing else in the request had ever seen.
    'request-id': (_request, ctx) => {
      ctx.headers.set('x-request-id', ctx.requestId);
      return undefined;
    },

    admit: (_request, ctx) => {
      // Before the trace, the route match, auth, the body — everything. A refusal that costs as
      // much as a served request is not load shedding, and this is the stage that makes
      // "reject 40% fast, serve 60% at p99" expressible at all.
      if (isDraining()) {
        ctx.headers.set('retry-after', SHED_RETRY_AFTER_SECONDS);
        throw draining();
      }
      const ceiling = config.maxInflight;
      // `beginWork()` in `server.ts` counted THIS request before the pipeline was entered, so the
      // ceiling is compared against a number that already includes it.
      if (ceiling > 0 && inflightCount() > ceiling) {
        ctx.headers.set('retry-after', SHED_RETRY_AFTER_SECONDS);
        throw overloaded(inflightCount(), ceiling);
      }
      return undefined;
    },

    trace: (_request, ctx) => {
      ctx.headers.set('x-trace-id', ctx.traceId);
      return undefined;
    },

    context: (request, ctx) => {
      // A preflight carries no credentials, so answering it after `auth` would 401
      // every legitimate cross-origin call.
      const answered = preflight(request.raw, config.cors);
      if (answered !== undefined) return answered;

      ctx.clientBuildId = request.header(config.buildIdHeader);
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

    /**
     * The two values land on `ctx.locale` / `ctx.tz` — core's own declared fields, which is what
     * makes `currentLocale()` and `currentTimeZone()` answer for this request once `pipeline.ts`
     * publishes the context into the ALS. This stage decides only WHERE to read them from; the
     * owners decide what they mean, so `Accept-Language: zh-Hant-TW` and `x-timezone: eUrOpE/bErLiN`
     * get one answer in the framework rather than one per package.
     */
    locale: (request, ctx) => {
      const cookies = request.header('cookie');
      ctx.locale = resolveLocale({
        header: request.header('accept-language'),
        cookie: readCookie(cookies, config.locale.cookie),
      }).locale;
      ctx.tz = resolveTimeZone({
        cookie: readCookie(cookies, config.tz.cookie),
        header: request.header(config.tz.header),
      }).zone;
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

    csrf: (request, ctx) => {
      const verdict = checkCsrf({
        method: ctx.method,
        // `ctx.https`, not `ctx.url.protocol`: behind a TLS-terminating ingress the internal hop
        // is plain http while the browser's `Origin` says https, so comparing the raw URL would
        // refuse every legitimate form post in the shape the framework's own chart ships.
        selfOrigin: selfOrigin(ctx.url, ctx.https),
        origin: request.header('origin'),
        secFetchSite: request.header('sec-fetch-site'),
        hasAuthorizationHeader: request.header('authorization') !== null,
        anonymous: isAnonymous(ctx.actor),
        cors: config.cors,
        config: config.csrf,
      });
      if (!verdict.ok) throw csrfBlocked(ctx.url.pathname, verdict.reason);
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
        throw forbidden(
          ctx.url.pathname,
          `no authorizer wired for policy ${route.meta.policy}`,
          route.meta.policy,
        );
      }
      const decision = await hooks.authorize(route, request, ctx);
      ctx.authz = decision;
      if (!decision.allowed) throw forbidden(ctx.url.pathname, decision.reason, route.meta.policy);
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

    'error-map': async (request, ctx) => {
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
      // FIELDS, never interpolation. `logger.emit()` redacts `bound`, `contextFields` and
      // `fields` — never `msg` — so a cause baked into the message reached the log store past
      // every rule that exists to stop it: a rejected `{"password":"hunter2"}` was logged
      // verbatim, at 4xx, which is logged and not reported and therefore kept for the full
      // retention. The message is the CODE alone; everything variable is a field.
      // The other half of this is `@ultimat3/schema`'s, and it is the load-bearing one: an issue
      // message must stop echoing the rejected value at all. This change makes the value
      // redactable; it does not make it absent.
      ctx.logger.error(facts.code, { cause: facts.cause, status: facts.status });
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
      // The limiter's own decision first — it is the live one and it knows this request's bucket —
      // then whatever the THROWABLE computed. Only the first half existed, so every other refusal
      // that had a delay to give told the caller to come back without saying when:
      // `X_ACCOUNT_LOCKED` is a 429 with no `Retry-After` at all, and `X_OVERLOADED` from
      // `@ultimat3/auth`'s KDF gate carries the number in `meta` under a comment saying the host
      // reads it. Nothing was the host.
      // `> 0` and not merely `!== undefined`: `RateLimitDecision.retryAfterSeconds` is `0` on an
      // ALLOWED request, so a handler raising `X_RATE_LIMITED` from a limiter of its own — an
      // action's declared `rateLimit`, `@ultimat3/auth`'s credential limiter — was answered
      // `retry-after: 0`, which is "retry now" and is the stampede the header exists to spread.
      const decided =
        facts.code === 'X_RATE_LIMITED' && (ctx.rateLimit?.retryAfterSeconds ?? 0) > 0
          ? ctx.rateLimit?.retryAfterSeconds
          : undefined;
      const seconds = decided ?? retryAfterOf(error);
      const retryAfter = seconds === undefined ? {} : { 'retry-after': String(seconds) };
      // One sniff, two documents: a browser is never handed a problem document, and an agent is
      // never handed a page. Which of the two a browser gets is the ENVIRONMENT — the overlay
      // prints the cause, the fix and the stack, which is what a visitor may never see.
      if (acceptsHtml(request.raw)) {
        if (config.dev) {
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
        return errorPageResponse(
          {
            status: facts.status,
            code: facts.code,
            path: ctx.url.pathname,
            requestId: ctx.requestId,
            locale: ctx.locale,
            // The rule the 403 page may name, and the one the `authz` stage was evaluating —
            // never a row, never the actor. `forbidden`'s own `fix:` already cites this field.
            ...(ctx.route?.meta.policy === undefined ? {} : { permission: ctx.route.meta.policy }),
            ...(seconds === undefined ? {} : { retryAfterSeconds: seconds }),
            signInPath: config.signInPath,
          },
          // The app's own file, read per request by whoever mounted the hook. A throw here is
          // caught by `recoverWith` and degrades to the problem document, which is the answer a
          // page whose renderer failed can still give.
          { override: await hooks.errorPage?.(facts.status, ctx), headers: retryAfter },
        );
      }
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
