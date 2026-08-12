/** Public API of `@ultimat3/render`: the `route` primitive, the five modes, the table. */

import { installRenderLoader } from './module-loader';

// A side effect on import, deliberately: a Bun plugin only transforms modules loaded AFTER it, and
// every consumer that will ever load a `.tsx` route or a `.scss` module imports this package first
// (an app's route file imports `defineRoute` from here before it imports anything else it owns).
// Any later hook — `x dev`, `x build`, `server.ts` — would each have to remember, which is four
// places one fact can be wrong instead of none.
installRenderLoader();

export type { CompiledStylesheet } from './css-modules';
export { compileStylesheet, isCssModule, isGlobalStylesheet, scopeClasses } from './css-modules';
export type { RenderErrorCode } from './errors';
export {
  BudgetExceededError,
  PrerenderFailedError,
  RENDER_ERROR_CODES,
  RENDER_ERROR_TITLES,
  RouteDuplicateError,
  RouteFileInvalidError,
  RouteLoadFailedError,
  RouteLoadInvalidError,
  RouteMetaMissingError,
  RouteModeInvalidError,
  RouteOfflineMissingError,
  SurfaceBoundaryError,
} from './errors';
export type {
  HeadRenderers,
  HeadTag,
  HeadTagKind,
  LdRenderer,
  MetaRenderer,
  ThemeScriptOptions,
} from './head';
export {
  documentBaseline,
  headFromMeta,
  mergeHead,
  renderHead,
  THEME_SCRIPT_MAX_BYTES,
  themeScript,
} from './head';
export { headTagKey, seoRenderers, toHeadTag } from './head-seo';
export type { IslandDirective } from './hydrate';
export {
  DEFAULT_REPLAY_EVENTS,
  emitIslandAttributes,
  emitIslandProps,
  hydrateRuntime,
  hydrateRuntimeBytes,
  requiredStrategies,
} from './hydrate';
export type { BudgetReport, BundleGraph, GraphName, Island, RouteBytes } from './islands';
export {
  assertBudget,
  checkBudget,
  checkBudgets,
  formatBytes,
  graphFor,
  parseByteBudget,
  routeJsBytes,
} from './islands';
export type { JsxComponent, JsxNode, JsxProps } from './jsx';
export { Fragment, h, isJsxNode, JSX_NODE } from './jsx';
export type { ModeCheckContext, ModeSpec, RouteShape } from './modes';
export {
  assertModeInvariants,
  assertModeShape,
  defaultHydrate,
  MODE_SPECS,
  RENDER_MODES,
} from './modes';
export type { Stylesheet } from './module-loader';
export {
  clearStylesheets,
  installRenderLoader,
  loadStylesheet,
  registeredStylesheets,
  stylesFor,
  transformTsx,
} from './module-loader';
export type {
  CompiledPattern,
  RegisterRouteInput,
  RouteDescriptor,
  RouteEntry,
  RouteMatch,
} from './registry';
export {
  clearRoutes,
  compilePattern,
  describeRoutes,
  matchRoute,
  ROUTE_FILENAME,
  registerRoute,
  routeCount,
  routeEntries,
  routeFor,
  routePathFromFile,
} from './registry';
export { renderComponent, renderToHtml } from './render-html';
export type {
  IsrController,
  IsrControllerOptions,
  IsrEntry,
  IsrRenderFn,
  IsrServeResult,
  IsrState,
  IsrStore,
} from './render-isr';
export {
  createIsrController,
  invalidateAndRevalidate,
  memoryIsrStore,
  parseTtlMs,
} from './render-isr';
export type { SpaShell, SpaShellInput } from './render-spa';
export { renderSpa, renderSpaShell, SPA_ROOT_ID } from './render-spa';
export type { SsrOptions, SsrRenderFn, SsrRenderInput } from './render-ssr';
export { renderSsr, ssrHeaders } from './render-ssr';
export type { StaticArtifact, StaticBuildOptions, StaticRenderFn } from './render-static';
export {
  assertNoPerRequestState,
  contentHash,
  enumeratePrerender,
  fillPath,
  renderStatic,
  staticHeaders,
  staticResult,
} from './render-static';
export type { StreamHole, StreamOptions, StreamPlan } from './render-stream';
export {
  collectStream,
  holeId,
  holeMarker,
  REVEAL_SCRIPT,
  renderStreamHtml,
  revealChunk,
  streamResult,
} from './render-stream';
export type {
  HydrateStrategy,
  OfflineStrategy,
  PrerenderFn,
  RenderMode,
  RenderResult,
  RevalidateConfig,
  RouteBudget,
  RouteConfig,
  RouteContext,
  RouteData,
  RouteDefinition,
  RouteGuard,
  RouteLoadAsyncFn,
  RouteLoadFn,
  RouteMetaAsyncFn,
  RouteMetaContext,
  RouteMetaFn,
  RouteParams,
} from './route';
export {
  defineRoute,
  HYDRATE_STRATEGIES,
  isRouteConfig,
  OFFLINE_STRATEGIES,
  tagKeys,
} from './route';
export type { RouteComponent } from './route-component';
export { pageComponentOf } from './route-component';
export { metaContextFor, routeDataFor } from './route-data';
export type {
  NavigateOptions,
  NavigationGuard,
  PrefetchContainer,
  PrefetchLink,
  ReactivePrimitives,
  ResolvedRoute,
  Router,
  RouterHost,
  RouterOptions,
  RouterRoute,
} from './router-client';
export { createRouter } from './router-client';
export type {
  BoundaryRule,
  BoundaryViolation,
  ImportGraph,
  ImportRef,
  Surface,
  SurfaceSpec,
} from './surfaces';
export {
  assertSurfaceBoundary,
  checkSurfaceBoundary,
  importGraph,
  SURFACE_SPECS,
  SURFACES,
  surfaceAllows,
  surfaceOf,
} from './surfaces';
