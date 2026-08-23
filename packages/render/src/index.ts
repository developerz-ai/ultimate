/**
 * The CLIENT half of `@ultimat3/render` — the `route` primitive, the JSX factory, islands, and the
 * tables describing them — kept disjoint from `@ultimat3/render/server` because everything here
 * must bundle for a browser, which the loaders cannot (axiom 6).
 */

/**
 * The route vocabulary is declared once, at tier 0 (`@ultimat3/core`), and re-exported here
 * because `defineRoute`, `MODE_SPECS`, `surfaceAllows` and `RouteDescriptor` all take these types
 * in their signatures: a consumer calling this package's API should not need a second import to
 * name its arguments. A re-export is not a declaration — `scripts/render-modes.test.ts` refuses a
 * second declaration, which is what makes re-exporting safe where copying was not.
 */
export type { HydrateStrategy, OfflineStrategy, RenderMode } from '@ultimat3/core';
// `formatBytes` moved to `@ultimat3/core` (one formatter, with the `mb` branch this package's copy
// never had); still named here because `@ultimat3/cli`'s budget reporter reads it beside the route
// table it prints against.
export { formatBytes, HYDRATE_STRATEGIES, OFFLINE_STRATEGIES, RENDER_MODES } from '@ultimat3/core';
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
  HYDRATE_RUNTIME_BODIES,
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
export { parseByteBudget } from './islands';
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
export type {
  CompiledPattern,
  RegisterRouteInput,
  RouteDescriptor,
  RouteEntry,
} from './registry';
export {
  clearRoutes,
  compilePattern,
  describeRoutes,
  ROUTE_FILENAME,
  registerRoute,
  routeCount,
  routeEntries,
  routeFor,
  routePathFromFile,
} from './registry';
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
