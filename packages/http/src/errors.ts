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
  'X_RATE_LIMIT_NOT_SHARED',
  'X_RATE_LIMIT_BUCKET_CONFLICT',
  'X_RATE_LIMIT_BUCKET_UNBOUND',
  'X_RATE_LIMIT_SCOPE_UNSET',
  'X_RATE_LIMIT_INVALID',
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
  X_RATE_LIMIT_NOT_SHARED: 'the rate limit is declared fleet-wide and the store is per-process',
  X_RATE_LIMIT_BUCKET_CONFLICT: 'a route and the config declare different numbers for one bucket',
  X_RATE_LIMIT_BUCKET_UNBOUND: 'the installed limiter cannot enforce a bucket a route declares',
  X_RATE_LIMIT_SCOPE_UNSET: 'the deployment has not said where the rate limiter keeps its counters',
  X_RATE_LIMIT_INVALID: 'a declared rate limit computes to numbers the limiter cannot run on',
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

const docsFor = (code: HttpErrorCode): string => `https://ultimate.dev/errors/${code}`;

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
      docs: docsFor(init.code),
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

export const bodyInvalid = (pathname: string, issues: readonly string[]): HttpError =>
  new HttpError({
    code: 'X_BODY_INVALID',
    cause: `${pathname} body rejected: ${issues.join('; ')}`,
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

export const forbidden = (pathname: string, reason: string): HttpError =>
  new HttpError({
    code: 'X_FORBIDDEN',
    cause: `${pathname} denied: ${reason}`,
    fix: `x policy explain ${pathname} --json   # shows which clause denied`,
  });

/**
 * The KEY never reaches the caller. `rateLimitKey` is `${routeName}|org:${orgId}` — or
 * `actor:${actorId}` — so the old cause handed an anonymous caller promoted to an org bucket the
 * internal org id, in a 429 anyone can provoke. It rides in `meta`, which the problem document
 * does not render and the error reporter does.
 */
export const rateLimited = (key: string, retryAfterSeconds: number): HttpError =>
  new HttpError({
    code: 'X_RATE_LIMITED',
    cause: `the rate limit for this caller is exhausted; it refills in ${retryAfterSeconds}s`,
    fix: 'retry after the Retry-After header, or raise rateLimit.buckets in app.config.ts',
    meta: { key, retryAfterSeconds },
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
 * At `createServer`/`createPipeline`, never on the request. `replicas: 3` behind one config means
 * each process holds its own counters, so every configured number is enforced three times over —
 * a green `x verify` and a limit that is not the limit. The declaration is the app's because the
 * framework cannot see its replica count, and a framework that guessed would guess wrong.
 */
export const rateLimitNotShared = (found: 'process' | 'disabled'): HttpError =>
  new HttpError({
    code: 'X_RATE_LIMIT_NOT_SHARED',
    cause:
      found === 'disabled'
        ? "http.rateLimit.scope is 'shared' but http.rateLimit.enabled is false, so the fleet-wide limit is enforced nowhere"
        : "http.rateLimit.scope is 'shared' but the installed store keeps its counters in this process, so each replica would enforce the full bucket on its own",
    fix: "pass a store whose scope is 'shared' — createServer({ routes, rateLimitStore }) — or set http.rateLimit.scope: 'process' in app.config.ts to accept per-replica limits",
  });

/**
 * The numbers of one bucket, spelled structurally so `errors.ts` stays free of an import from
 * `rate-limit.ts` — which imports this file.
 */
interface BucketNumbers {
  readonly capacity: number;
  readonly refillPerSecond: number;
}

const numbers = (bucket: BucketNumbers): string => `${bucket.capacity} / ${bucket.refillPerSecond}`;

/**
 * Two declarations of one bucket, at `createServer`/`createPipeline`. Neither wins: an app that
 * configures `rateLimit.buckets.<name>` and a route that declares its own numbers under that name
 * disagree about what is enforced, and whichever a merge picked would leave the other a number
 * someone read and nothing applies — the failure this seam exists to end. The message speaks
 * capacity and refill rather than the `limit`/`windowMs` an action declares, because that is what
 * the limiter runs on; `toBucket` (`rate-limit.ts`, this package) is the conversion between them —
 * it lives here because http owns `Bucket` and the maths, and both tier-3 callers need it.
 */
export const rateLimitBucketConflict = (input: {
  bucket: string;
  /** `null` when the other declaration is `app.config.ts` rather than a second route. */
  otherRoute: string | null;
  route: string;
  other: BucketNumbers;
  declared: BucketNumbers;
}): HttpError =>
  new HttpError({
    code: 'X_RATE_LIMIT_BUCKET_CONFLICT',
    cause: `bucket "${input.bucket}" has two declarations: ${
      input.otherRoute === null
        ? 'http.rateLimit.buckets in app.config.ts'
        : `route "${input.otherRoute}"`
    } says ${numbers(input.other)}, route "${input.route}" says ${numbers(input.declared)} (capacity / refill per second)${
      input.otherRoute === null
        ? `; if ${numbers(input.other)} is what this deployment means to enforce, then the route's declaration is the half that is wrong and app.config.ts is not where to say so`
        : ''
    }`,
    // One edit, named. Two joined by "or" leaves the reader to decide which declaration is
    // authoritative — and the route is, always: it sits beside the handler and it is what the
    // OpenAPI operation publishes, so a config entry duplicating it is the copy that goes stale.
    fix:
      input.otherRoute === null
        ? `delete http.rateLimit.buckets.${input.bucket} from app.config.ts — the route's declaration is the one the OpenAPI operation publishes, so edit the numbers there if ${numbers(input.declared)} is wrong`
        : `rename the bucket route "${input.route}" declares — one name is one limit, and "${input.bucket}" is already route "${input.otherRoute}"'s`,
  });

/**
 * A route declares its own bucket and the INSTALLED limiter cannot enforce it — at
 * `createPipeline`, never on the request. `createRateLimiter` closes over the config it was built
 * with, so a limiter constructed before the routes existed resolves the route's bucket name
 * through `bucketFor`, misses, and falls through to `default`: measured at 120 burst and 21 of 21
 * requests allowed for a route declaring 5. Silent, and looser than what the author wrote.
 *
 * Refused rather than rebound, for two reasons. A `RateLimiter` is opaque — no store and no table
 * are reachable through it — so "binding" it would mean discarding the caller's limiter and the
 * store it carries, which is a different silent failure. And a caller who built their own limiter
 * may have meant their own numbers; picking for them is the precedence mistake
 * `X_RATE_LIMIT_BUCKET_CONFLICT` exists to refuse.
 */
export const rateLimitBucketUnbound = (input: {
  bucket: string;
  route: string;
  declared: BucketNumbers;
  /** What the limiter holds under that name, or `null` for "holds nothing / declares no table". */
  found: BucketNumbers | null;
}): HttpError =>
  new HttpError({
    code: 'X_RATE_LIMIT_BUCKET_UNBOUND',
    cause: `route "${input.route}" declares bucket "${input.bucket}" as ${numbers(input.declared)} (capacity / refill per second) and the installed limiter ${
      input.found === null
        ? 'does not hold that bucket, so the route would run on the default one'
        : `holds ${numbers(input.found)} for it`
    }`,
    fix: 'pass the STORE and let the pipeline build the limiter — createServer({ routes, rateLimitStore }) — so the bucket table is the one the routes registered',
  });

export const routeConflict = (path: string, detail: string): HttpError =>
  new HttpError({
    code: 'X_ROUTE_CONFLICT',
    cause: `${path} conflicts with an already registered route: ${detail}`,
    fix: `x routes list --json   # remove or rename one of the two routes at ${path}`,
  });

/**
 * At `defineHttpConfig`, never on the request. `scope` used to DEFAULT to `'process'`, so an app
 * that declared nothing enforced every configured number once per replica — three times over on
 * the chart this repo ships — with a green `x verify` and nothing to read. The boot check that
 * catches the other half (`assertRateLimitScope`) only fires for an app that said `'shared'`, so
 * the silent case was exactly the one nobody declared. One process is still a legal answer; it is
 * no longer an assumed one.
 */
export const rateLimitScopeUnset = (): HttpError =>
  new HttpError({
    code: 'X_RATE_LIMIT_SCOPE_UNSET',
    cause:
      'http.rateLimit is enabled and the deployment has not declared http.rateLimit.scope, so the numbers below it are per replica rather than per fleet',
    fix: "in app.config.ts set http.rateLimit.scope: 'process' if this app runs as ONE replica, or 'shared' plus createServer({ routes, rateLimitStore }) for a fleet-wide limit",
  });

/**
 * A `{ limit, windowMs }` pair the limiter cannot run on. Raised by `toBucket` (`rate-limit.ts`),
 * which lives in this PACKAGE because http owns `Bucket` and the maths, and two tier-3 packages
 * (`action`, `query`) need the same conversion without importing each other.
 */
export const rateLimitInvalid = (input: {
  readonly owner: string;
  readonly limit: number;
  readonly windowMs: number;
  readonly reason: string;
}): HttpError =>
  new HttpError({
    code: 'X_RATE_LIMIT_INVALID',
    cause: `"${input.owner}" declares rateLimit { limit: ${input.limit}, windowMs: ${input.windowMs} }: ${input.reason}`,
    fix: `edit the \`rateLimit:\` on ${input.owner} to a whole allowance over a real window — e.g. { limit: 5, windowMs: 600_000 } for five per ten minutes — or delete it to keep the default bucket`,
    meta: { owner: input.owner, limit: input.limit, windowMs: input.windowMs },
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
