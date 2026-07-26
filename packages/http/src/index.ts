// The public surface of @ultimat3/http. Explicit, never `export *`: what is not
// listed here is an implementation detail and may change without a major bump.

export type { HttpConfig, HttpConfigInput } from './config';
export { defineHttpConfig, stripBasePath } from './config';
export type { ActorView, RequestContext, RequestContextInit } from './context';
export {
  actorView,
  asCtx,
  createRequestContext,
  elapsedMs,
  useRequestContext,
} from './context';
export type { CorsConfig } from './cors';
export { corsHeaders, DEFAULT_CORS, preflight } from './cors';
export type { ErrorFacts, ProblemDocument } from './error-map';
export {
  DEFAULT_STATUS,
  ERROR_STATUS,
  factsOf,
  renderErrorLines,
  statusFor,
  toProblem,
} from './error-map';
export type { HttpErrorCode } from './errors';
export {
  bodyInvalid,
  buildSkew,
  forbidden,
  HTTP_ERROR_CODES,
  HTTP_ERROR_TITLES,
  HttpError,
  methodNotAllowed,
  pipelineNoResponse,
  rateLimited,
  routeConflict,
  routeNotFound,
  serverNotStarted,
  unauthenticated,
} from './errors';
export type { AuthzDecision, ServerHooks } from './hooks';
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
export type { OverlayMeta } from './overlay';
export { overlayResponse, renderOverlay, wantsOverlay } from './overlay';
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
export type { QueryValues } from './request';
export { UltimateRequest } from './request';
export type { CacheHint } from './response';
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
export { buildCsp, DEFAULT_SECURITY, securityHeaders } from './security-headers';
export type { LifecycleState, ServerHandle, ServerOptions } from './server';
export { createServer } from './server';
export type { InferOutput, Schema, ValidationOutcome } from './validate';
export { formatIssue, validate, validateSync } from './validate';
