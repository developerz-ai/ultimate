// The public surface of @ultimat3/http. Explicit, never `export *`: what is not
// listed here is an implementation detail and may change without a major bump.

export type { RenderMode } from '@ultimat3/core';
// The wire format is `@ultimat3/core`'s and is RE-EXPORTED, never re-declared: it is one module at
// the tier both halves can reach, because `@ultimat3/jobs` signs a delivery, this package verifies
// one, and neither may import the other. Re-exported here so a receiver route needs one import.
export {
  isCanonicalWebhookField,
  WEBHOOK_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_SIGNATURE_VERSION,
  WEBHOOK_TOPIC_HEADER,
} from '@ultimat3/core';
export type { AppHttpConfig, BootOwnedHttpKey } from './app-config';
export { configuredHttp, configureHttp, mergeHttpConfig, resetHttpConfig } from './app-config';
export { NEXT_PARAM, nextAfterSignIn, signInRedirect } from './auth-redirect';
export type { HttpConfig, HttpConfigInput } from './config';
export { defineHttpConfig, MAX_PROXY_HOPS, stripBasePath } from './config';
export type { ActorView, RequestContext, RequestContextInit } from './context';
export {
  actorView,
  asCtx,
  createRequestContext,
  elapsedMs,
  useRequestContext,
  useRequestCookie,
  useRequestHeader,
  useRequestHeaders,
} from './context';
export type { InboundCorrelation } from './correlation';
export { readCorrelation } from './correlation';
export type { CorsConfig } from './cors';
export { allowedOrigin, corsHeaders, DEFAULT_CORS, preflight } from './cors';
export type { CsrfCheckInput, CsrfConfig, CsrfMode, CsrfVerdict } from './csrf';
export { checkCsrf, DEFAULT_CSRF, selfOrigin } from './csrf';
export type { Deadline } from './deadline';
export { REQUEST_TIMEOUT_HEADER, resolveTimeoutMs, startDeadline } from './deadline';
export type { ErrorFacts, ProblemDocument } from './error-facts';
export {
  factsOf,
  problemTypeFor,
  renderErrorLines,
  retryAfterOf,
  toProblem,
} from './error-facts';
export {
  DEFAULT_STATUS,
  ERROR_STATUS,
  registerErrorStatus,
  resetErrorStatus,
  statusFor,
} from './error-map';
export type {
  ErrorPageAction,
  ErrorPageCopy,
  ErrorPageGroup,
  ErrorPageInput,
  ErrorPageOptions,
} from './error-page';
export {
  ERROR_PAGE_LINKS,
  errorPageResponse,
  renderErrorPage,
  resolveErrorPageCopy,
} from './error-page';
export type { HttpErrorCode } from './errors';
export {
  bodyInvalid,
  buildSkew,
  csrfBlocked,
  draining,
  errorStatusInvalid,
  finalizeFailed,
  forbidden,
  HTTP_ERROR_CODES,
  HTTP_ERROR_TITLES,
  HttpError,
  methodNotAllowed,
  noRequest,
  overloaded,
  pathInvalid,
  pipelineNoResponse,
  requestTimedOut,
  routeCacheInvalid,
  routeConflict,
  routeNotFound,
  serverNotStarted,
  trustProxyUnset,
  unauthenticated,
  webhookSignatureInvalid,
  webhookSignatureStale,
} from './errors';
export type { ForwardedInput, ForwardedSplit } from './forwarded';
export {
  clientAddress,
  clientUsedHttps,
  FORWARDED_CLIENT_CERT,
  FORWARDED_FOR,
  FORWARDED_PROTO,
  forwardedElement,
  forwardedValue,
} from './forwarded';
export type { Authenticator, AuthzDecision, ServerHooks } from './hooks';
export { configureAuthenticator, configuredAuthenticator, resetAuthenticator } from './hooks';
export { acceptsHtml, escapeHtml } from './html-render';
export type { LocaleConfig, TimeZoneConfig } from './locale';
export { DEFAULT_LOCALE_CONFIG, DEFAULT_TZ_CONFIG, readCookie } from './locale';
export type { Middleware } from './middleware';
export { compose } from './middleware';
export type { OverlayMeta, OverlayNotice } from './overlay';
export { overlayResponse, renderOverlay, wantsOverlay } from './overlay';
export { OVERLAY_STYLE } from './overlay-style';
export type { PeerIdentity } from './peer-identity';
export { peerIdentity } from './peer-identity';
export type { HandleInit, Pipeline, PipelineDeps } from './pipeline';
export { createPipeline, PIPELINE_STAGES } from './pipeline';
export type {
  Bucket,
  MemoryRateLimitStore,
  RateLimitConfig,
  RateLimitDecision,
  RateLimitDeclaration,
  RateLimiter,
  RateLimitKeyParts,
  RateLimitScope,
  RateLimitSpend,
  RateLimitStore,
} from './rate-limit';
export {
  assertRateLimitScope,
  createRateLimiter,
  DEFAULT_MAX_RATE_LIMIT_KEYS,
  DEFAULT_RATE_LIMIT,
  memoryRateLimitStore,
  rateLimitDecision,
  rateLimitSpends,
  resolveRateLimitConfig,
  TENANT_SCOPE,
  toBucket,
} from './rate-limit';
export { assertRouteBuckets, withRouteBuckets } from './rate-limit-buckets';
export {
  rateLimitBucketConflict,
  rateLimitBucketUnbound,
  rateLimited,
  rateLimitInvalid,
  rateLimitNotShared,
  rateLimitScopeUnset,
  rateLimitStoreUnavailable,
  tenantBucketUnknown,
} from './rate-limit-errors';
export type {
  PgExecutor,
  PostgresRateLimitStore,
  PostgresRateLimitStoreOptions,
} from './rate-limit-postgres';
export {
  postgresRateLimitStore,
  SQL_RATE_LIMIT_PURGE,
  SQL_RATE_LIMIT_RESET,
  SQL_RATE_LIMIT_TABLE,
  SQL_RATE_LIMIT_TAKE,
} from './rate-limit-postgres';
export { setRedirect, takeRedirect } from './redirect';
export type { QueryValues } from './request';
export { UltimateRequest } from './request';
export type { CacheHint, RedirectIntent, RedirectStatus } from './response';
export {
  applyCacheHeaders,
  cacheControl,
  html,
  json,
  NO_STORE,
  noContent,
  problem,
  redirect,
  stream,
  text,
  withHeaders,
} from './response';
export type {
  HttpMethod,
  MatchResult,
  Route,
  RouteDescription,
  RouteHandler,
  RouteMeta,
  RouteParams,
  RouteTable,
} from './router';
export {
  createRouter,
  describeRoutes,
  HTTP_METHODS,
  matchRoute,
  normalizePath,
} from './router';
export type { SecurityConfig } from './security-headers';
export { buildCsp, cspHashSource, DEFAULT_SECURITY, securityHeaders } from './security-headers';
export type { LifecycleState, ServerHandle, ServerOptions } from './server';
export { createServer } from './server';
// The stage vocabulary comes from its declaration site, beside the fourteen implementations it
// names; `PIPELINE_STAGES` — the ORDER — stays `pipeline.ts`'s.
export type { Stage, StageDoc, StageName, StagePhase, StageRun } from './stages';
export type { InferOutput, Schema, ValidationOutcome } from './validate';
export { formatIssue, validate, validateSync } from './validate';
export type { VerifiedWebhook, WebhookVerifyOptions } from './webhook-verify';
export {
  DEFAULT_WEBHOOK_BODY_LIMIT,
  DEFAULT_WEBHOOK_TOLERANCE_MS,
  verifyWebhookSignature,
} from './webhook-verify';
