// The HTTP layer's stable error codes. Every throw in this package goes through a
// factory here so a code, a cause and an exact fix always travel together — the
// terminal, the dev overlay and `--json` all render the same three strings.
import { registerErrorCodes, UltimateError } from '@ultimat3/core';

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
] as const;

/**
 * Codes this package throws but does NOT own. `X_FORBIDDEN` belongs to `@ultimat3/policy` and
 * `X_UNAUTHENTICATED` to `@ultimat3/auth`; registering either here would throw
 * `X_ERROR_CODE_DUPLICATE` at import. No titles for them either — the owner writes the one title
 * every surface renders, and a copy kept here is a copy that goes stale without anything failing.
 */
export const HTTP_BORROWED_ERROR_CODES = ['X_UNAUTHENTICATED', 'X_FORBIDDEN'] as const;

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
};

// Registered at module load, unconditionally, in one call, so core's registry renders OUR title
// everywhere. Without this the registry humanises the code (`X_BUILD_SKEW` → "build skew"); with a
// presence guard, a package that claimed one of these first would silently keep its own title.
registerErrorCodes(
  Object.fromEntries(Object.entries(HTTP_ERROR_TITLES).map(([code, title]) => [code, { title }])),
);

const docsFor = (code: HttpErrorCode): string => `https://ultimate.dev/errors/${code}`;

/** Base class for every error this package throws. Never throw a bare `Error`. */
export class HttpError extends UltimateError {
  override readonly name = 'HttpError';

  constructor(init: { code: HttpErrorCode; cause: string; fix: string }) {
    super({
      code: init.code,
      cause: init.cause,
      fix: init.fix,
      docs: docsFor(init.code),
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
    fix: `x schema show ${pathname} --json   # then send a body matching the input schema`,
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

export const rateLimited = (key: string, retryAfterSeconds: number): HttpError =>
  new HttpError({
    code: 'X_RATE_LIMITED',
    cause: `bucket for ${key} is empty; refills in ${retryAfterSeconds}s`,
    fix: 'retry after the Retry-After header, or raise rateLimit.buckets in app.config.ts',
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
    cause: `the "${stage}" stage threw while finishing the response: ${
      cause instanceof Error ? cause.message : String(cause)
    }`,
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
 * the limiter runs on; `toBucket` in `@ultimat3/action` is the conversion between them.
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
