// The HTTP layer's stable error codes. Every throw in this package goes through a
// factory here so a code, a cause and an exact fix always travel together — the
// terminal, the dev overlay and `--json` all render the same three strings.
import {
  registerErrorCodes,
  registerErrorRetry,
  renderThrowable,
  UltimateError,
} from '@ultimat3/core';

/** Codes this package declares and owns. */
export const HTTP_OWNED_ERROR_CODES = [
  'X_ROUTE_NOT_FOUND',
  'X_METHOD_NOT_ALLOWED',
  'X_PATH_INVALID',
  'X_BODY_INVALID',
  'X_RATE_LIMITED',
  'X_BUILD_SKEW',
  'X_ROUTE_CONFLICT',
  'X_SERVER_NOT_STARTED',
  'X_PIPELINE_NO_RESPONSE',
  'X_PIPELINE_FINALIZE_FAILED',
  'X_NO_REQUEST',
  'X_ERROR_STATUS_INVALID',
  'X_CORS_CONFIG_INVALID',
  'X_CSP_DIRECTIVE_INVALID',
  'X_RATE_LIMIT_NOT_SHARED',
  'X_RATE_LIMIT_BUCKET_CONFLICT',
  'X_RATE_LIMIT_BUCKET_UNBOUND',
  'X_RATE_LIMIT_SCOPE_UNSET',
  'X_RATE_LIMIT_INVALID',
  'X_RATE_LIMIT_STORE_UNAVAILABLE',
  'X_TRUST_PROXY_UNSET',
  'X_OVERLOADED',
  'X_CSRF_BLOCKED',
] as const;

/**
 * Codes this package throws but does NOT own. `X_FORBIDDEN` belongs to `@ultimat3/policy` and
 * `X_UNAUTHENTICATED` to `@ultimat3/auth`; registering either here would throw
 * `X_ERROR_CODE_DUPLICATE` at import. No titles for them either — the owner writes the one title
 * every surface renders, and a copy kept here is a copy that goes stale without anything failing.
 */
export const HTTP_BORROWED_ERROR_CODES = [
  'X_UNAUTHENTICATED',
  'X_FORBIDDEN',
  // `X_TIMEOUT` has had its 504 row in `ERROR_STATUS` since the table was written and nothing in
  // the framework threw it. The request deadline does now — borrowed rather than owned because
  // the concept is core's (`Clock`, `throwIfAborted`) and a title registered here would throw
  // `X_ERROR_CODE_DUPLICATE` at import the day core writes its own.
  'X_TIMEOUT',
  // Core's, titled in `CORE_CODE_TITLES` and classified `retryable` in `error-retry.ts`, because
  // the lifecycle that answers `isDraining()` is core's. The `admit` stage is its first thrower:
  // this package documented answering 503 while draining and had no reader of the flag at all.
  'X_DRAINING',
] as const;

/** Every code http can throw: the ones it owns plus the two it borrows. */
export const HTTP_ERROR_CODES = [...HTTP_OWNED_ERROR_CODES, ...HTTP_BORROWED_ERROR_CODES] as const;

export type HttpOwnedErrorCode = (typeof HTTP_OWNED_ERROR_CODES)[number];
export type HttpErrorCode = (typeof HTTP_ERROR_CODES)[number];

/** Human title per owned code. Kept next to the codes so one edit updates every surface. */
export const HTTP_ERROR_TITLES: Readonly<Record<HttpOwnedErrorCode, string>> = {
  X_ROUTE_NOT_FOUND: 'no route matches this request',
  X_METHOD_NOT_ALLOWED: 'route exists but not for this method',
  X_PATH_INVALID: 'a path segment is not valid percent-encoding',
  X_BODY_INVALID: 'request body failed its schema',
  X_RATE_LIMITED: 'rate limit exhausted for this key',
  X_BUILD_SKEW: 'client build id does not match the server build id',
  X_ROUTE_CONFLICT: 'two routes claim the same path',
  X_SERVER_NOT_STARTED: 'server handle used before start()',
  X_PIPELINE_NO_RESPONSE: 'a pipeline stage produced no response',
  X_PIPELINE_FINALIZE_FAILED: 'a finalize stage threw instead of finishing the response',
  X_NO_REQUEST: 'the inbound request is not in scope here',
  X_ERROR_STATUS_INVALID: 'an error code cannot be mapped to that status',
  X_CORS_CONFIG_INVALID: 'the cors config can never produce a working response',
  X_CSP_DIRECTIVE_INVALID: 'a csp extension would emit something other than the directive it names',
  X_RATE_LIMIT_NOT_SHARED: 'the rate limit is declared fleet-wide and the store is per-process',
  X_RATE_LIMIT_BUCKET_CONFLICT: 'a route and the config declare different numbers for one bucket',
  X_RATE_LIMIT_BUCKET_UNBOUND: 'the installed limiter cannot enforce a bucket a route declares',
  X_RATE_LIMIT_SCOPE_UNSET: 'the deployment has not said where the rate limiter keeps its counters',
  X_RATE_LIMIT_INVALID: 'a declared rate limit computes to numbers the limiter cannot run on',
  X_RATE_LIMIT_STORE_UNAVAILABLE: 'the shared rate-limit store did not answer, so nothing decided',
  X_TRUST_PROXY_UNSET: 'proxy headers are trusted without saying how many proxies are in front',
  X_OVERLOADED: 'in-flight requests are at the configured ceiling',
  X_CSRF_BLOCKED: 'a credentialed write arrived from an origin that is not allowed to make it',
};

// Registered at module load, unconditionally, in one call, so core's registry renders OUR title
// everywhere. Without this the registry humanises the code (`X_BUILD_SKEW` → "build skew"); with a
// presence guard, a package that claimed one of these first would silently keep its own title.
registerErrorCodes(
  Object.fromEntries(Object.entries(HTTP_ERROR_TITLES).map(([code, title]) => [code, { title }])),
);

/**
 * The two codes this package throws that a client is SUPPOSED to come back from, and both say
 * when: each carries `retry-after` on the response. Unclassified defaults to `terminal`, which is
 * right for the rest — a 404, a 422 and a wiring bug all fail the same way forever — but wrong for
 * a shed request, whose whole contract is "not now". Only codes this package OWNS are listed:
 * `X_TIMEOUT` and `X_DRAINING` are borrowed, and core classifies its own.
 */
registerErrorRetry({
  X_RATE_LIMITED: 'retry-after',
  X_OVERLOADED: 'retry-after',
});

// No `docs:` below. `UltimateError` fills it from `describeErrorCode(code).docs`, which is
// `@ultimat3/core`'s `ERROR_DOCS_URL` — one page for every code, never one per code, because
// `wiki/` is the framework's only public documentation surface and a code lives there in a TABLE
// ROW, which has no anchor. The `https://ultimate.dev/errors/<code>` links this file built until
// 9.x answered 404, host included — and this package put them in `type` AND `docs` of every
// problem document, so the dead link was on every 4xx and 5xx an app has ever served.

/** Base class for every error this package throws. Never throw a bare `Error`. */
export class HttpError extends UltimateError {
  override readonly name = 'HttpError';

  constructor(init: {
    code: HttpErrorCode;
    cause: string;
    fix: string;
    /**
     * Facts an operator needs and a CALLER must not be handed. `toProblem` renders code, cause,
     * fix and docs — never this — so the rate limiter's internal key rides here instead of in a
     * 429 body that told an anonymous caller the org id it had been promoted to.
     */
    meta?: Readonly<Record<string, unknown>>;
  }) {
    super({
      code: init.code,
      cause: init.cause,
      fix: init.fix,
      ...(init.meta === undefined ? {} : { meta: init.meta }),
    });
  }
}

export const routeNotFound = (method: string, pathname: string): HttpError =>
  new HttpError({
    code: 'X_ROUTE_NOT_FOUND',
    cause: `no route registered for ${method} ${pathname}`,
    fix: `x routes list --json   # then: x g route ${pathname}`,
  });

export const methodNotAllowed = (
  method: string,
  pathname: string,
  allow: readonly string[],
): HttpError =>
  new HttpError({
    code: 'X_METHOD_NOT_ALLOWED',
    cause: `${pathname} accepts ${allow.join(', ')} but the request used ${method}`,
    fix: `add a ${method} route for ${pathname} or call it with ${allow[0] ?? 'GET'}`,
  });

/**
 * The client wrote the path, so the client is who can fix it — 400, not the 500 the bare
 * `URIError` from `decodeURIComponent` used to produce. `X_INTERNAL` reported a typo to the error
 * monitor (`pipeline.ts` pages on `status >= 500`) and told the caller nothing.
 */
export const pathInvalid = (pathname: string, segment: string): HttpError =>
  new HttpError({
    code: 'X_PATH_INVALID',
    cause: `${pathname} contains "${segment}", which is not valid percent-encoding`,
    fix: 'send the segment percent-encoded — encodeURIComponent(value); a literal % is %25',
  });

/**
 * `issues` is the CALLER-facing half and must name only facts the framework itself chose — a
 * schema rule, a byte count, a content-type the router supports. Anything the caller sent goes in
 * `meta`, which `toProblem` never renders and `stages.ts` never writes into the log message: a
 * `cause` reaches the log store as an unredactable field AND the problem document, so a value
 * baked into it has no key left to redact. The runtime's `SyntaxError` quotes the token it choked
 * on, which is how a fragment of `{"password": …}` used to travel in both directions at once.
 */
export const bodyInvalid = (
  pathname: string,
  issues: readonly string[],
  meta?: Readonly<Record<string, unknown>>,
): HttpError =>
  new HttpError({
    code: 'X_BODY_INVALID',
    cause: `${pathname} body rejected: ${issues.join('; ')}`,
    ...(meta === undefined ? {} : { meta }),
    // `x schema show` is not a command — not in the registry and not in `PLANNED_COMMANDS`, so it
    // exits `X_CLI_UNKNOWN_COMMAND`. The same axiom-4 inversion `x logs tail` had in `error-map`:
    // the one instruction the reader is given fails when they run it. `x routes` ships, and
    // `hasInputSchema` plus the route's name is what it prints.
    fix: `x routes --json   # find ${pathname}, then send a body matching its input schema`,
  });

export const unauthenticated = (pathname: string): HttpError =>
  new HttpError({
    code: 'X_UNAUTHENTICATED',
    cause: `${pathname} declares auth: 'required' and no actor was resolved`,
    fix: "send a session cookie or Authorization header, or set meta.auth to 'public'",
  });

/**
 * `x policy explain` resolves a policy SUBJECT — a permission, an action name or a query name.
 * A route pathname is none of those, and the only callers of this factory (`stages.ts`' `authz`)
 * had nothing but `ctx.url.pathname` to hand it: `x policy explain /settings` exits
 * `X_DECLARATION_UNKNOWN`, so the one command a 403 told the reader to run was the one command
 * that could not work. `route.meta.policy` is what the stage was evaluating and what the index
 * can resolve, so that is the argument.
 */
const POLICY_SUBJECT = /^[a-z0-9_-]+:[a-z0-9_-]+$/;

/**
 * A composite policy renders `and(a:b, c:d)`, which is not a subject either — so anything that is
 * not a bare `resource:verb` degrades to the route table, the shape `bodyInvalid` above uses. A
 * fix that names the wrong thing is not a fix; a fix that resolves is.
 */
export const forbidden = (pathname: string, reason: string, policy?: string): HttpError =>
  new HttpError({
    code: 'X_FORBIDDEN',
    cause: `${pathname} denied: ${reason}`,
    fix:
      policy !== undefined && POLICY_SUBJECT.test(policy)
        ? `x policy explain ${policy} --json   # shows which clause denied`
        : `x routes --json   # find ${pathname}, then read the policy it declares`,
  });

export const buildSkew = (clientBuildId: string, serverBuildId: string): HttpError =>
  new HttpError({
    code: 'X_BUILD_SKEW',
    cause: `client sent build ${clientBuildId}, server is running ${serverBuildId}`,
    fix: 'reload the page — the service worker will fetch the new build manifest',
  });

export const serverNotStarted = (member: string): HttpError =>
  new HttpError({
    code: 'X_SERVER_NOT_STARTED',
    cause: `${member} was read before start() bound a socket`,
    fix: 'call createServer({ ... }).start() before reading url()',
  });

export const pipelineNoResponse = (stage: string): HttpError =>
  new HttpError({
    code: 'X_PIPELINE_NO_RESPONSE',
    cause: `the pipeline finished at stage "${stage}" without a response`,
    fix: 'return a Response from the route handler, or a Response from the stage that short-circuits',
  });

/**
 * A finalize stage threw on the response it was handed. `Pipeline.handle` promises a Response to
 * every caller, so the throw becomes this — a 500 the client can read and report — instead of a
 * rejected promise the server has nothing to send for.
 */
export const finalizeFailed = (stage: string, cause: unknown): HttpError =>
  new HttpError({
    code: 'X_PIPELINE_FINALIZE_FAILED',
    // A stage throws whatever the app threw, and this factory is the last thing standing between
    // that value and `finalize.ts`'s promise that `handle()` resolves to a Response. `instanceof`
    // runs a `Proxy`'s `getPrototypeOf` trap and `.message` runs a getter, so both reads go
    // through core's total `renderThrowable` — the fast path was the last unguarded one here.
    cause: `the "${stage}" stage threw while finishing the response: ${renderThrowable(cause)}`,
    fix: 'return a Response built here — json(), text(), html() or redirect() from @ultimat3/http; one whose headers cannot be set, like Response.redirect(), cannot take the final headers',
  });

/**
 * A request-scoped reader used where no request exists — a job, a task, a boot-time module
 * body. Loud, because the alternative (`null`) reads as "the caller sent no cookie", which is
 * how an unauthenticated job would quietly run as nobody.
 */
export const noRequest = (member: string): HttpError =>
  new HttpError({
    code: 'X_NO_REQUEST',
    cause: `${member} was read outside an HTTP request`,
    fix: 'move this call inside a route handler, an action or a page — or, for a job, call useRequestCookie(name) at enqueue time and pass the value in the payload',
  });

export const errorStatusInvalid = (code: string, reason: string): HttpError =>
  new HttpError({
    code: 'X_ERROR_STATUS_INVALID',
    cause: `${code} cannot be mapped: ${reason}`,
    fix: `x errors list --json   # then registerErrorStatus({ ${code}: 422 }) with a status the framework does not already own`,
  });

/**
 * At `defineHttpConfig`, never on the request. A CORS pair a browser can never accept resolves to
 * "emit no CORS headers at all", which is unreadable from the console: every cross-origin call
 * fails and nothing on the server said anything.
 */
export const corsConfigInvalid = (reason: string): HttpError =>
  new HttpError({
    code: 'X_CORS_CONFIG_INVALID',
    cause: `cors config rejected: ${reason}`,
    fix: "in app.config.ts set http.cors.credentials: false, or replace http.cors.origins: ['*'] with the exact origins allowed to call this app",
  });

/**
 * At `defineHttpConfig`. A directive name and a source both go into the header VERBATIM, and the
 * header's own separators are `;` and ` ` — so `extend: { 'x; script-src *': [] }` is not one
 * badly named directive, it is a second directive nobody declared, widening the one this
 * framework locks down hardest. Refused where it is written rather than escaped where it is
 * emitted: there is no encoding for a CSP directive, so the only total answer is not to have one.
 */
export const cspDirectiveInvalid = (where: string, value: string): HttpError =>
  new HttpError({
    code: 'X_CSP_DIRECTIVE_INVALID',
    cause: `${where} is not a csp token: ${JSON.stringify(value)}`,
    fix: 'in app.config.ts write one http.security.csp.extend entry per directive, each source its own array element — a directive name is [a-z][a-z0-9-]*, and no source may contain a space, a comma or a semicolon',
  });

export const routeConflict = (path: string, detail: string): HttpError =>
  new HttpError({
    code: 'X_ROUTE_CONFLICT',
    cause: `${path} conflicts with an already registered route: ${detail}`,
    fix: `x routes list --json   # remove or rename one of the two routes at ${path}`,
  });

/**
 * At `defineHttpConfig`. `trustProxy` is a claim about the DEPLOYMENT — that something in front
 * rewrites `x-forwarded-for` — and the leftmost value in that header is whatever the client
 * typed. Without a hop count there is no way to tell the proxy's entry from the caller's, so
 * trusting the header at all is trusting the caller. Asked in the same shape as
 * `X_RATE_LIMIT_NOT_SHARED`, and for the same reason: only the app knows its own topology.
 */
export const trustProxyUnset = (): HttpError =>
  new HttpError({
    code: 'X_TRUST_PROXY_UNSET',
    cause:
      'http.trustProxy is true and http.trustedProxyHops is not set, so x-forwarded-for would be read from a position the client controls',
    fix: 'in app.config.ts set http.trustedProxyHops to the number of proxies that append to x-forwarded-for — 1 for a single ingress or ALB, 2 for a CDN in front of one — or set http.trustProxy: false when this process is reached directly',
  });

/**
 * SIGTERM has run the `accept` phase: `readyz` is already 503 and the socket is closing, but a
 * connection the load balancer had not yet stopped using still arrives. Answering it with a
 * coded 503 and a `Retry-After` is what `packages/http/CLAUDE.md` claimed the layer did — until
 * this stage, `isDraining()` had no reader in this package at all.
 */
export const draining = (): HttpError =>
  new HttpError({
    code: 'X_DRAINING',
    cause: 'this process is draining and will not start new work',
    fix: 'retry after the Retry-After header — another replica is already serving, and this one is being replaced',
  });

/**
 * Shed BEFORE any work: no route match, no auth, no body, no query. The alternative is not
 * "serve everyone", it is "serve nobody" — every request queues behind the same pool, p99 walks
 * off the chart and client retries multiply the load. `@ultimat3/realtime`'s `AcceptBudget` is
 * the same decision for sockets; this is the one HTTP never had.
 */
export const overloaded = (inflight: number, ceiling: number): HttpError =>
  new HttpError({
    code: 'X_OVERLOADED',
    cause: `${inflight} requests are already in flight and http.maxInflight is ${ceiling}`,
    fix: 'retry after the Retry-After header; to serve more at once raise http.maxInflight in app.config.ts, and add replicas to match',
  });

/**
 * A write that arrived with the browser's ambient credential and could not be shown to come from
 * this app. Never a 401: the caller IS signed in, which is precisely the problem.
 */
export const csrfBlocked = (pathname: string, reason: string): HttpError =>
  new HttpError({
    code: 'X_CSRF_BLOCKED',
    cause: `${pathname} refused a credentialed write: ${reason}`,
    fix: "call it with an Authorization header instead of the session cookie, add the calling origin to http.cors.origins in app.config.ts, or set http.csrf.mode: 'off' if this app has no cookie session at all",
  });

/**
 * The request ran past its deadline. `X_TIMEOUT` is borrowed (see `HTTP_BORROWED_ERROR_CODES`)
 * and already maps to 504. The abort fires first for cooperative code; this is what the socket
 * gets when the handler never looked at `ctx.signal`.
 */
export const requestTimedOut = (method: string, pathname: string, timeoutMs: number): HttpError =>
  new HttpError({
    code: 'X_TIMEOUT',
    cause: `${method} ${pathname} did not finish within ${timeoutMs}ms`,
    fix: 'pass ctx.signal to every outbound call (fetch(url, { signal: ctx.signal })) and call throwIfAborted(ctx) before expensive work, or raise http.requestTimeoutMs in app.config.ts',
    meta: { timeoutMs },
  });
