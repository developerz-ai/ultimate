// The HTTP layer's stable error codes. Every throw in this package goes through a
// factory here so a code, a cause and an exact fix always travel together — the
// terminal, the dev overlay and `--json` all render the same three strings.
import { registerErrorCodes, UltimateError } from '@ultimat3/core';

/** Codes this package declares and owns. */
export const HTTP_OWNED_ERROR_CODES = [
  'X_ROUTE_NOT_FOUND',
  'X_METHOD_NOT_ALLOWED',
  'X_BODY_INVALID',
  'X_RATE_LIMITED',
  'X_BUILD_SKEW',
  'X_ROUTE_CONFLICT',
  'X_SERVER_NOT_STARTED',
  'X_PIPELINE_NO_RESPONSE',
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
  X_BODY_INVALID: 'request body failed its schema',
  X_RATE_LIMITED: 'rate limit exhausted for this key',
  X_BUILD_SKEW: 'client build id does not match the server build id',
  X_ROUTE_CONFLICT: 'two routes claim the same path',
  X_SERVER_NOT_STARTED: 'server handle used before start()',
  X_PIPELINE_NO_RESPONSE: 'a pipeline stage produced no response',
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

export const routeConflict = (path: string, detail: string): HttpError =>
  new HttpError({
    code: 'X_ROUTE_CONFLICT',
    cause: `${path} conflicts with an already registered route: ${detail}`,
    fix: `x routes list --json   # remove or rename one of the two routes at ${path}`,
  });
