// The public surface of @ultimat3/http. Explicit, never `export *`: what is not
// listed here is an implementation detail and may change without a major bump.

// Imported bare, and the one module `sideEffects` lists: the codes' titles and the `retry-after`
// class of a 429 and a 503 are read by `UltimateError`, which never imports this module — so a
// server realm that reaches the barrel registers them whatever it constructs. `SIDE_EFFECTS_ANCHORS`
// carries the argument and `bun run side-effects` enforces it.
import './error-titles';

export type { PgExecutor, RenderMode } from '@ultimat3/core';
// No core VALUE is re-exported here (`X_HELPER_COPY`, `bun run flight-copies`): the webhook wire
// format (`WEBHOOK_*`, `isCanonicalWebhookField`), `escapeHtml` and `readCookie` are imported from
// `@ultimat3/core`, their one home, by every caller.
export type { AppHttpConfig, BootOwnedHttpKey } from './app-config';
export { configuredHttp, configureHttp, mergeHttpConfig, resetHttpConfig } from './app-config';
export { NEXT_PARAM, nextAfterSignIn, signInRedirect } from './auth-redirect';
export type {
  BearerCaller,
  BearerMountInput,
  BearerMountRateLimit,
  BearerResolver,
} from './bearer-mount';
export { bearerMount, bearerTokenOf, mountedPath } from './bearer-mount';
/** One `Range:` reader for every route that answers bytes — `/_storage`, site assets, a download. */
export type { RequestedRange } from './byte-range';
export { byteWindow, contentRangeOf, parseByteRange, RANGE_UNSATISFIABLE } from './byte-range';
export { PRIVATE_REVALIDATE } from './cache-policy';
export { COMPRESS_MAX_BYTES, COMPRESS_MIN_BYTES, isCompressibleType } from './compress';
/** The build-time coders (brotli 11, zstd 19, gzip 9) — what `x build --target static` writes. */
export type { Precoding } from './compress-precode';
export { PRECODERS, PRECODINGS } from './compress-precode';
export type { HttpConfig, HttpConfigInput } from './config';
export { defineHttpConfig, MAX_PROXY_HOPS } from './config';
export type { ActorView, RequestContext, RequestContextInit } from './context';
export {
  actorView,
  asCtx,
  elapsedMs,
  requestContext,
  useRequestBodyBytes,
  useRequestContext,
  useRequestCookie,
  useRequestHeader,
  useRequestHeaders,
  withAnonymousRequest,
} from './context';
export type { CorsConfig } from './cors';
export { allowedOrigin, DEFAULT_CORS, originListed, preflight } from './cors';
export type { CsrfCheckInput, CsrfConfig, CsrfMode, CsrfVerdict } from './csrf';
export { checkCsrf, csrfBlocked, selfOrigin } from './csrf';
export type { Deadline } from './deadline';
export { resolveTimeoutMs, startDeadline } from './deadline';
export type { ErrorFacts, ProblemDocument } from './error-facts';
export { factsOf, problemTypeFor, renderErrorLines, retryAfterOf, toProblem } from './error-facts';
export { ERROR_STATUS } from './error-map';
export type { ErrorPageInput } from './error-page';
export { ERROR_PAGE_LINKS, renderErrorPage } from './error-page';
export {
  DEFAULT_STATUS,
  declaredStatusFor,
  registerErrorStatus,
  resetErrorStatus,
  statusFor,
} from './error-status';
export type { HttpErrorCode } from './errors';
export {
  bodyInvalid,
  buildSkew,
  draining,
  finalizeFailed,
  forbidden,
  HTTP_ERROR_CODES,
  HTTP_ERROR_TITLES,
  HttpError,
  methodNotAllowed,
  noRequest,
  overloaded,
  requestTimedOut,
  routeNotFound,
  unauthenticated,
} from './errors';
export type { ForwardedInput, ForwardedSplit } from './forwarded';
export { clientAddress, forwardedElement } from './forwarded';
export type { Authenticator, AuthenticatorOptions, AuthzDecision, ServerHooks } from './hooks';
export {
  configureAuthenticator,
  configuredAuthenticator,
  configuredCredentialTtlMs,
  MAX_CREDENTIAL_TTL_MS,
  resetAuthenticator,
} from './hooks';
export { acceptsHtml } from './html-render';
export { socketIdleTimeoutSeconds } from './idle-timeout';
export type { LocaleConfig, TimeZoneConfig } from './locale';
export { DEFAULT_LOCALE_CONFIG, DEFAULT_TZ_CONFIG } from './locale';
export type { RequestAddress } from './locale-prefix';
export { requestAddress } from './locale-prefix';
export type { Middleware } from './middleware';
export { compose } from './middleware';
export type { NavigationPurpose } from './navigation';
export {
  hostlessPath,
  locationFor,
  navigationGate,
  navigationPurpose,
  redirectForRouter,
  relocate,
} from './navigation';
export type {
  ObjectRequest,
  ObjectResponseOptions,
  ObjectSource,
  ServableObject,
} from './object-response';
export { notModified, objectResponse } from './object-response';
export type { OverlayNotice } from './overlay';
export { wantsOverlay } from './overlay';
export { OVERLAY_STYLE } from './overlay-style';
export type { PeerIdentity } from './peer-identity';
export type { HandleInit, Pipeline, PipelineDeps } from './pipeline';
export { httpPipeline, PIPELINE_STAGES, REQUEST_ID_ATTRIBUTE } from './pipeline';
export type { ProblemMeta, ProblemMetaDeclaration, ProblemMetaValue } from './problem-meta';
export { MAX_PROBLEM_META_BYTES, registerProblemMeta } from './problem-meta';
export type {
  Bucket,
  MemoryRateLimitStore,
  RateLimitConfig,
  RateLimitDecision,
  RateLimiter,
  RateLimitKeyParts,
  RateLimitScope,
  RateLimitSpend,
  RateLimitStore,
} from './rate-limit';
export {
  assertRateLimitScope,
  DEFAULT_MAX_RATE_LIMIT_KEYS,
  memoryRateLimitStore,
  rateLimitDecision,
  rateLimiter,
  rateLimitSpends,
} from './rate-limit';
export { assertRouteBuckets, withRouteBuckets } from './rate-limit-buckets';
export type { RateLimitDeclaration } from './rate-limit-config';
export { DEFAULT_RATE_LIMIT, resolveRateLimitConfig, toBucket } from './rate-limit-config';
export { rateLimited, rateLimitInvalid } from './rate-limit-errors';
export { publishRateLimit, rateLimitHeaders } from './rate-limit-headers';
export { assertInstalledRateLimitScope, installedRateLimitStore } from './rate-limit-installed';
export type { RateLimitPeek } from './rate-limit-peek';
export { rateLimitPeek, refilledTokens } from './rate-limit-peek';
export type { PostgresRateLimitStore, PostgresRateLimitStoreOptions } from './rate-limit-postgres';
export {
  postgresRateLimitStore,
  RATE_LIMIT_STORAGE,
  SQL_RATE_LIMIT_TABLE,
} from './rate-limit-postgres';
export type {
  RedisRateLimitClient,
  RedisRateLimitStore,
  RedisRateLimitStoreOptions,
} from './rate-limit-redis';
export { redisRateLimitStore } from './rate-limit-redis';
export { RATE_LIMIT_STORE_DEADLINE_MS } from './rate-limit-store-deadline';
export { setRedirect, takeRedirect } from './redirect';
export type { QueryValues } from './request';
export { UltimateRequest } from './request';
export type { ExerciseRequest, ExerciseRequestOption } from './request-as';
export { withRequestAs } from './request-as';
export type { RequestFacts, RequestFactsInput } from './request-facts';
export { requestFacts } from './request-facts';
export type { RequestTimings } from './request-timings';
export { requestTimings, subscribeRequestTimings } from './request-timings';
export type { CacheHint, RedirectIntent, RedirectStatus } from './response';
export {
  applyCacheHeaders,
  cacheControl,
  html,
  jsonResponse,
  NO_STORE,
  problem,
  redirect,
  stream,
  textResponse,
  withHeaders,
} from './response';
export { canonicalPath } from './route-path';
export type {
  HttpMethod,
  MatchResult,
  Route,
  RouteDescription,
  RouteHandler,
  RouteMeta,
  RouteNavigation,
  RouteParams,
  RouteTable,
} from './router';
export { describeRoutes, httpRouter, matchRoute } from './router';
export type { SecurityConfig } from './security-headers';
export { buildCsp, cspHashSource, DEFAULT_SECURITY, securityHeaders } from './security-headers';
export type {
  LifecycleState,
  ServerHandle,
  ServerOptions,
  UpgradeTarget,
  WebSocketMount,
} from './server';
export { httpServer } from './server';
export type { WebSocketOption } from './server-websocket';
export type { DeleteCookieOptions } from './set-cookie';
export { deleteCookie, setCookie } from './set-cookie';
export { SLOW_REQUEST_MESSAGE } from './slow-request-log';
// The stage vocabulary comes from its declaration site, beside the fifteen implementations it
// names; `PIPELINE_STAGES` — the ORDER — stays `pipeline.ts`'s.
export type { Stage, StageDoc, StageName, StagePhase, StageRun } from './stages';
export type { InferOutput, Schema, ValidationOutcome } from './validate';
export { formatIssue, validateBody, validateSync } from './validate';
export type { BodyHmacOptions, VerifiedBody } from './webhook-hmac';
export { verifyBodyHmac } from './webhook-hmac';
export type { VerifiedWebhook, WebhookVerifyOptions } from './webhook-verify';
export { DEFAULT_WEBHOOK_BODY_LIMIT, verifyWebhookSignature } from './webhook-verify';
export type { JoinedWebSocketMounts } from './websocket-mounts';
export { joinWebSocketMounts } from './websocket-mounts';
