// @ultimat3/http's owned codes, their TITLES and the two retry classes, registered at import — the
// one module `sideEffects` names, imported bare by the barrel and by `errors.ts`. Its readers are
// in the SERVER realm (`x errors list`, a problem document, a job's retry), which reaches the
// barrel. A browser never needs it: core's decoders take an unregistered code's title from the
// problem body and a 429's `retry-after` from its `Retry-After` header. Until the package declared
// `sideEffects`, all of http — router, limiter, error maps, 11.5 kB — rode into every action island.

import { registerErrorCodes, registerErrorRetry } from '@ultimat3/core';

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
  'X_PROBLEM_META_INVALID',
  'X_CORS_CONFIG_INVALID',
  'X_CSP_DIRECTIVE_INVALID',
  'X_RATE_LIMIT_NOT_SHARED',
  'X_RATE_LIMIT_BUCKET_CONFLICT',
  'X_RATE_LIMIT_BUCKET_UNBOUND',
  'X_RATE_LIMIT_SCOPE_UNSET',
  'X_RATE_LIMIT_INVALID',
  'X_RATE_LIMIT_STORE_UNAVAILABLE',
  'X_RATE_LIMIT_TENANT_BUCKET_UNKNOWN',
  'X_TRUST_PROXY_UNSET',
  'X_OVERLOADED',
  'X_CSRF_BLOCKED',
  'X_WEBHOOK_SIGNATURE_INVALID',
  'X_WEBHOOK_SIGNATURE_STALE',
  'X_BEARER_MOUNT_INVALID',
] as const;

export type HttpOwnedErrorCode = (typeof HTTP_OWNED_ERROR_CODES)[number];

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
  X_PROBLEM_META_INVALID: 'a problem document cannot carry that meta declaration',
  X_CORS_CONFIG_INVALID: 'the cors config can never produce a working response',
  X_CSP_DIRECTIVE_INVALID: 'a csp extension would emit something other than the directive it names',
  X_RATE_LIMIT_NOT_SHARED: 'the rate limit is declared fleet-wide and the store is per-process',
  X_RATE_LIMIT_BUCKET_CONFLICT: 'a route and the config declare different numbers for one bucket',
  X_RATE_LIMIT_BUCKET_UNBOUND: 'the installed limiter cannot enforce a bucket a route declares',
  X_RATE_LIMIT_SCOPE_UNSET: 'the deployment has not said where the rate limiter keeps its counters',
  X_RATE_LIMIT_INVALID: 'a declared rate limit computes to numbers the limiter cannot run on',
  X_RATE_LIMIT_STORE_UNAVAILABLE: 'the shared rate-limit store did not answer, so nothing decided',
  X_RATE_LIMIT_TENANT_BUCKET_UNKNOWN: 'the tenant allowance names a bucket nothing declares',
  X_TRUST_PROXY_UNSET: 'proxy headers are trusted without saying how many proxies are in front',
  X_OVERLOADED: 'in-flight requests are at the configured ceiling',
  X_CSRF_BLOCKED: 'an unsafe request that did not prove same-origin',
  X_WEBHOOK_SIGNATURE_INVALID: 'the inbound webhook is not signed by the holder of this secret',
  X_WEBHOOK_SIGNATURE_STALE: 'the inbound webhook is signed correctly and is too old to accept',
  X_BEARER_MOUNT_INVALID: 'a bearer mount declaration cannot be served as written',
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
