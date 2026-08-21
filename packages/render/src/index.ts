/** Public API of `@ultimat3/render`: the `route` primitive, the five modes, the table. */

import { installRenderLoader } from './module-loader';

// A side effect on import, deliberately: a Bun plugin only transforms modules loaded AFTER it, and
// every consumer that will ever load a `.tsx` route or a `.scss` module imports this package first
// (an app's route file imports `defineRoute` from here before it imports anything else it owns).
// Any later hook — `x dev`, `x build`, `server.ts` — would each have to remember, which is four
// places one fact can be wrong instead of none.
installRenderLoader();

/**
 * The route vocabulary is declared once, at tier 0 (`@ultimat3/core`), and re-exported here
 * because `defineRoute`, `MODE_SPECS`, `surfaceAllows` and `RouteDescriptor` all take these types
 * in their signatures: a consumer calling this package's API should not need a second import to
 * name its arguments. A re-export is not a declaration — `scripts/render-modes.test.ts` refuses a
 * second declaration, which is what makes re-exporting safe where copying was not.
 */
export type { HydrateStrategy, OfflineStrategy, RenderMode } from '@ultimat3/core';
export { HYDRATE_STRATEGIES, OFFLINE_STRATEGIES, RENDER_MODES } from '@ultimat3/core';
export type { CompiledStylesheet } from './css-modules';
export { compileStylesheet, isCssModule, isGlobalStylesheet, scopeClasses } from './css-modules';
export { parseTtlMs } from './duration';
export type { RenderErrorCode } from './errors';
export {
  BudgetExceededError,
  IslandInvalidError,
  IslandNotHydratedError,
  IslandPropsInvalidError,
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
  IDLE_HYDRATE_TIMEOUT_MS,
  ISLAND_FAILED_ATTRIBUTE,
  ISLAND_MOUNTED_ATTRIBUTE,
  requiredStrategies,
} from './hydrate';
export type { IslandComponent, IslandDeclaration, IslandNode, IslandSpec } from './island';
export {
  ISLAND_EXTENSION,
  ISLAND_NODE,
  isEmittableSpecifier,
  isIslandNode,
  island,
  islandModuleId,
} from './island';
export type { IslandCollector, IslandCollectorInput } from './island-collector';
export { createIslandCollector, islandModuleIds } from './island-collector';
export type { IslandProps, JsonValue } from './island-props';
export { checkIslandProps, ISLAND_PROPS_MAX_BYTES } from './island-props';
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
  DEFAULT_ISLAND_JS_BYTES,
  defaultHydrate,
  defaultIslandBudget,
  MODE_SPECS,
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
export type { RenderHtmlOptions } from './render-html';
export { ROOT_ELEMENT_ID, renderComponent, renderToHtml } from './render-html';
export type {
  IsrController,
  IsrControllerOptions,
  IsrEntry,
  IsrRenderFn,
  IsrServeResult,
  IsrState,
  IsrStore,
  MemoryIsrStoreOptions,
} from './render-isr';
export {
  createIsrController,
  DEFAULT_ISR_MAX_ENTRIES,
  invalidateAndRevalidate,
  isrKey,
  memoryIsrStore,
} from './render-isr';
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
  DEFAULT_HOLE_TIMEOUT_MS,
  holeId,
  holeMarker,
  REVEAL_SCRIPT,
  renderStreamHtml,
  revealChunk,
  streamResult,
} from './render-stream';
export type {
  LoadRequirement,
  PrerenderFn,
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
export { DEFAULT_ISLAND_HYDRATE, defineRoute, isRouteConfig, tagKeys } from './route';
export type { RouteComponent } from './route-component';
export { pageComponentOf } from './route-component';
export { metaContextFor, routeDataFor } from './route-data';
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
