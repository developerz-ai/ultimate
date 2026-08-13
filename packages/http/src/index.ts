// The public surface of @ultimat3/http. Explicit, never `export *`: what is not
// listed here is an implementation detail and may change without a major bump.

export { NEXT_PARAM, nextAfterSignIn, signInRedirect } from './auth-redirect';
export type { HttpConfig, HttpConfigInput } from './config';
export { defineHttpConfig, stripBasePath } from './config';
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
export type { CorsConfig } from './cors';
export { corsHeaders, DEFAULT_CORS, preflight } from './cors';
export type { ErrorFacts, ProblemDocument } from './error-map';
export {
  appErrorStatus,
  DEFAULT_STATUS,
  ERROR_STATUS,
  factsOf,
  registerErrorStatus,
  renderErrorLines,
  resetErrorStatus,
  statusFor,
  toProblem,
} from './error-map';
export type { HttpErrorCode } from './errors';
export {
  bodyInvalid,
  buildSkew,
  errorStatusInvalid,
  forbidden,
  HTTP_ERROR_CODES,
  HTTP_ERROR_TITLES,
  HttpError,
  methodNotAllowed,
  noRequest,
  pathInvalid,
  pipelineNoResponse,
  rateLimited,
  routeConflict,
  routeNotFound,
  serverNotStarted,
  unauthenticated,
} from './errors';
export type { Authenticator, AuthzDecision, ServerHooks } from './hooks';
export { configureAuthenticator, configuredAuthenticator, resetAuthenticator } from './hooks';
export type { LocaleConfig, TimeZoneConfig } from './locale';
export {
  DEFAULT_LOCALE_CONFIG,
  DEFAULT_TZ_CONFIG,
  isValidTimeZone,
  negotiateLocale,
  readCookie,
  resolveTimeZone,
} from './locale';
export type { Middleware } from './middleware';
export { compose } from './middleware';
export type { OverlayMeta, OverlayNotice } from './overlay';
export { overlayResponse, renderOverlay, wantsOverlay } from './overlay';
export { OVERLAY_STYLE } from './overlay-style';
export type {
  HandleInit,
  Pipeline,
  PipelineDeps,
  Stage,
  StageDoc,
  StageName,
  StagePhase,
  StageRun,
} from './pipeline';
export { createPipeline, PIPELINE_STAGES } from './pipeline';
export type {
  Bucket,
  RateLimitConfig,
  RateLimitDecision,
  RateLimiter,
  RateLimitKeyParts,
  RateLimitStore,
} from './rate-limit';
export {
  createRateLimiter,
  DEFAULT_RATE_LIMIT,
  memoryRateLimitStore,
  rateLimitKey,
} from './rate-limit';
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
  RenderMode,
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
export type { InferOutput, Schema, ValidationOutcome } from './validate';
export { formatIssue, validate, validateSync } from './validate';
